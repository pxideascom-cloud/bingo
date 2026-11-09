"""Run with `python server.py`. One process owns all live rooms."""

import asyncio
from collections import defaultdict, deque
from contextlib import asynccontextmanager, suppress
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlsplit
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from game import CODE_ALPHABET, GameError, Room
from ludo import LudoRoom, board_layout


BASE_DIR = Path(__file__).resolve().parent
rooms: dict[str, Room | LudoRoom] = {}
sockets: dict[str, WebSocket] = {}
room_locks: dict[str, asyncio.Lock] = {}
request_times: dict[str, deque] = defaultdict(deque)
RECONNECT_SECONDS = 300
EMPTY_ROOM_SECONDS = 7200
MAX_ROOMS = 2000


async def broadcast(room: Room | LudoRoom):
    async def send(player):
        socket = sockets.get(player.id)
        if socket:
            try:
                await asyncio.wait_for(socket.send_json(room.state_for(player)), timeout=5)
            except (RuntimeError, OSError, asyncio.TimeoutError):
                with suppress(Exception):
                    await socket.close()
    await asyncio.gather(*(send(player) for player in room.players))


async def clean_rooms():
    while True:
        await asyncio.sleep(30)
        now = time.monotonic()
        for code, room in list(rooms.items()):
            lock = room_locks.get(code)
            if lock is None:
                continue
            async with lock:
                stale = [p for p in room.players if not p.connected and now - p.disconnected_at > RECONNECT_SECONDS]
                for player in stale:
                    room.remove_player(player)
                if not room.players or (not any(p.connected for p in room.players) and now - room.updated_at > EMPTY_ROOM_SECONDS):
                    rooms.pop(code, None)
                    room_locks.pop(code, None)
                elif stale:
                    await broadcast(room)
        for address, times in list(request_times.items()):
            if not times or now - times[-1] > 60:
                request_times.pop(address, None)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cleanup = asyncio.create_task(clean_rooms())
    yield
    cleanup.cancel()
    with suppress(asyncio.CancelledError):
        await cleanup


app = FastAPI(title="The Bingo Club", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def response_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


class SeatRequest(BaseModel):
    name: str = Field(min_length=1, max_length=18)

    @field_validator("name", mode="before")
    @classmethod
    def normalize_name(cls, name):
        if not isinstance(name, str):
            raise ValueError("Please enter your name.")
        name = " ".join(name.split())
        if not name or any(not char.isprintable() for char in name):
            raise ValueError("Please enter a name using visible characters.")
        return name


class CreateRoomRequest(SeatRequest):
    game: Literal["bingo", "ludo"] = "bingo"
    player_count: Literal[2, 4] = 2

    @model_validator(mode="after")
    def validate_player_count(self):
        if self.game == "bingo" and self.player_count != 2:
            raise ValueError("Bingo rooms have two players. Choose Ludo for four players.")
        return self


def check_origin(origin: str | None, host: str | None) -> bool:
    if not origin:
        return True  # Allows native clients and command-line health checks.
    try:
        parsed = urlsplit(origin)
        return parsed.scheme in ("http", "https") and parsed.netloc.casefold() == (host or "").casefold()
    except ValueError:
        return False


def limit_requests(request: Request):
    if not check_origin(request.headers.get("origin"), request.headers.get("host")):
        raise HTTPException(403, "Please open the game directly to join.")
    address = request.client.host if request.client else "unknown"
    now = time.monotonic()
    times = request_times[address]
    while times and now - times[0] > 60:
        times.popleft()
    if len(times) >= 40:
        raise HTTPException(429, "Too many attempts. Please try again in a minute.")
    times.append(now)


def seat_response(room, player):
    return {"code": room.code, "player_id": player.id, "token": player.token,
            "game": "ludo" if isinstance(room, LudoRoom) else "bingo",
            "player_count": room.player_count if isinstance(room, LudoRoom) else 2}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/api/ludo/layout")
async def ludo_layout():
    return board_layout()


@app.post("/api/rooms", status_code=201)
async def create_room(body: CreateRoomRequest, request: Request):
    limit_requests(request)
    if len(rooms) >= MAX_ROOMS:
        raise HTTPException(503, "The club is busy. Please try again shortly.")
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
    while code in rooms:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
    room = LudoRoom(code=code, player_count=body.player_count) if body.game == "ludo" else Room(code=code)
    player = room.add_player(body.name)
    rooms[code] = room
    room_locks[code] = asyncio.Lock()
    return seat_response(room, player)


@app.post("/api/rooms/{code}/join")
async def join_room(code: str, body: SeatRequest, request: Request):
    limit_requests(request)
    code = code.upper()
    room = rooms.get(code)
    if room is None:
        raise HTTPException(404, "Room not found. Double-check the code or create a new room.")
    async with room_locks[code]:
        try:
            player = room.add_player(body.name)
        except GameError as error:
            raise HTTPException(409, str(error)) from error
        await broadcast(room)
        return seat_response(room, player)


@app.websocket("/ws/{code}")
async def game_socket(websocket: WebSocket, code: str):
    if not check_origin(websocket.headers.get("origin"), websocket.headers.get("host")):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    room = rooms.get(code.upper())
    if room is None:
        await websocket.send_json({"type": "expired", "message": "This room has expired. Create a fresh room."})
        await websocket.close(code=4004)
        return
    player = None
    lock = room_locks[room.code]
    try:
        # Keep the seat token out of URLs, access logs and invitation links.
        raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=10)
        if len(raw_auth) > 512:
            raise GameError("Invalid session. Please join again.")
        auth = json.loads(raw_auth)
        if not isinstance(auth, dict) or not isinstance(auth.get("token"), str):
            raise GameError("Invalid session. Please join again.")
        async with lock:
            player = room.authenticate(auth["token"])
            previous = sockets.get(player.id)
            sockets[player.id] = websocket
            if previous and previous is not websocket:
                with suppress(Exception):
                    await previous.close(code=4001, reason="Seat opened in another tab")
            room.connect(player)
            await broadcast(room)
        recent_messages = deque()
        while True:
            raw_message = await websocket.receive_text()
            now = time.monotonic()
            while recent_messages and now - recent_messages[0] > 5:
                recent_messages.popleft()
            if len(recent_messages) >= 40 or len(raw_message) > 1024:
                await websocket.close(code=1008, reason="Too many requests")
                break
            recent_messages.append(now)
            try:
                message = json.loads(raw_message)
                if not isinstance(message, dict):
                    raise GameError("Invalid game action.")
                async with lock:
                    if sockets.get(player.id) is not websocket:
                        break
                    if message.get("type") == "ping":
                        await websocket.send_json({"type": "pong"})
                    elif message.get("type") == "leave":
                        sockets.pop(player.id, None)
                        room.remove_player(player)
                        await broadcast(room)
                        await websocket.send_json({"type": "left"})
                        await websocket.close(code=1000)
                        break
                    else:
                        room.act(player, message)
                        await broadcast(room)
            except (GameError, json.JSONDecodeError) as error:
                await websocket.send_json({"type": "error", "message": str(error) if isinstance(error, GameError) else "Invalid game action."})
    except (GameError, json.JSONDecodeError) as error:
        with suppress(Exception):
            await websocket.send_json({"type": "expired", "message": str(error) if isinstance(error, GameError) else "Invalid session. Please join again."})
            await websocket.close(code=4003)
    except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError, OSError):
        pass
    finally:
        if player and sockets.get(player.id) is websocket:
            async with lock:
                sockets.pop(player.id, None)
                if player in room.players:
                    room.disconnect(player)
                    await broadcast(room)


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/ludo")
async def ludo_index():
    return FileResponse(BASE_DIR / "static" / "ludo.html", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn
    if os.name == "nt":
        # This network-only app needs no subprocess transports. The selector
        # loop also avoids Python 3.10's noisy Proactor errors on browser reload.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    uvicorn.run(
        "server:app", host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")), workers=1, ws_max_size=2048,
        timeout_keep_alive=30,
    )
