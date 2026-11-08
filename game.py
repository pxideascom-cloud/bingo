"""Server-owned rules for a two-player, 1–25 Bingo match."""

from dataclasses import dataclass, field
import secrets
import time


LINES = (
    [tuple(row * 5 + col for col in range(5)) for row in range(5)]
    + [tuple(row * 5 + col for row in range(5)) for col in range(5)]
    + [tuple(i * 6 for i in range(5)), tuple((i + 1) * 4 for i in range(5))]
)
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


class GameError(ValueError):
    pass


def shuffled_board() -> list[int]:
    board = list(range(1, 26))
    secrets.SystemRandom().shuffle(board)
    return board


@dataclass
class Player:
    name: str
    id: str = field(default_factory=lambda: secrets.token_hex(8))
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    board: list[int] = field(default_factory=shuffled_board)
    connected: bool = False
    ready: bool = False
    rematch: bool = False
    disconnected_at: float = field(default_factory=time.monotonic)


@dataclass
class Room:
    code: str
    players: list[Player] = field(default_factory=list)
    phase: str = "waiting"
    called: list[int] = field(default_factory=list)
    history: list[dict] = field(default_factory=list)
    turn_id: str | None = None
    winner_ids: list[str] = field(default_factory=list)
    round: int = 1
    revision: int = 0
    notice: str = ""
    updated_at: float = field(default_factory=time.monotonic)

    def touch(self):
        self.revision += 1
        self.updated_at = time.monotonic()

    def add_player(self, name: str) -> Player:
        if len(self.players) >= 2:
            raise GameError("This room is full. Create a new room for your game.")
        if self.phase != "waiting":
            raise GameError("This game has already started.")
        if any(p.name.casefold() == name.casefold() for p in self.players):
            raise GameError("That name is already taken in this room. Try another.")
        player = Player(name=name)
        self.players.append(player)
        self.notice = ""
        self.touch()
        return player

    def authenticate(self, token: str) -> Player:
        for player in self.players:
            if secrets.compare_digest(player.token.encode(), token.encode()):
                return player
        raise GameError("Your seat has expired. Please join the room again.")

    def completed_lines(self, player: Player) -> list[tuple[int, ...]]:
        called = set(self.called)
        return [line for line in LINES if all(player.board[i] in called for i in line)]

    def maybe_start(self):
        if self.phase == "waiting" and len(self.players) == 2 and all(
            p.ready and p.connected for p in self.players
        ):
            self.phase = "playing"
            self.turn_id = self.players[(self.round - 1) % 2].id
            self.notice = ""

    def connect(self, player: Player):
        player.connected = True
        self.maybe_start()
        self.touch()

    def disconnect(self, player: Player):
        player.connected = False
        player.disconnected_at = time.monotonic()
        self.touch()

    def remove_player(self, player: Player):
        self.players.remove(player)
        self.round += 1
        self.reset()
        self.notice = f"{player.name} left. Invite a friend to start a fresh game."
        self.touch()

    def reset(self):
        self.phase = "waiting"
        self.called.clear()
        self.history.clear()
        self.turn_id = None
        self.winner_ids.clear()
        self.notice = ""
        for player in self.players:
            player.board = shuffled_board()
            player.ready = False
            player.rematch = False

    def act(self, player: Player, message: dict):
        action = message.get("type")
        if action == "shuffle":
            if self.phase != "waiting" or player.ready:
                raise GameError("You can shuffle before you are ready.")
            player.board = shuffled_board()
        elif action == "ready":
            if self.phase != "waiting":
                raise GameError("The game has already started.")
            if type(message.get("ready")) is not bool:
                raise GameError("Choose whether you are ready.")
            player.ready = message["ready"]
            self.maybe_start()
        elif action == "call":
            self.call(player, message.get("number"))
        elif action == "rematch":
            if self.phase != "finished":
                raise GameError("Finish this game before starting another.")
            player.rematch = True
            if len(self.players) == 2 and all(p.rematch for p in self.players):
                self.round += 1
                self.reset()
        else:
            raise GameError("That action is not supported.")
        self.touch()

    def call(self, player: Player, number):
        if self.phase != "playing":
            raise GameError("The game is not in progress.")
        if not all(p.connected for p in self.players):
            raise GameError("The game is paused while your opponent reconnects.")
        if player.id != self.turn_id:
            raise GameError("It is your opponent's turn.")
        if type(number) is not int or not 1 <= number <= 25:
            raise GameError("Pick a whole number from 1 to 25.")
        if number in self.called:
            raise GameError("That number has already been called.")
        self.called.append(number)
        self.history.append({"number": number, "player_id": player.id, "name": player.name})
        # Check both cards on the same call: a simultaneous Bingo is a draw.
        self.winner_ids = [p.id for p in self.players if len(self.completed_lines(p)) >= 5]
        if self.winner_ids:
            self.phase = "finished"
            self.turn_id = None
        else:
            self.turn_id = next(p.id for p in self.players if p.id != player.id)

    def state_for(self, viewer: Player) -> dict:
        return {
            "type": "state",
            "code": self.code,
            "phase": self.phase,
            "round": self.round,
            "revision": self.revision,
            "you": viewer.id,
            "board": viewer.board[:],
            "completed_lines": self.completed_lines(viewer),
            "players": [
                {
                    "id": p.id, "name": p.name, "connected": p.connected,
                    "ready": p.ready, "rematch": p.rematch,
                    "lines": len(self.completed_lines(p)),
                }
                for p in self.players
            ],
            "called": self.called[:],
            "history": self.history[:],
            "turn_id": self.turn_id,
            "winner_ids": self.winner_ids[:],
            "paused": self.phase == "playing" and not all(p.connected for p in self.players),
            "notice": self.notice,
        }
