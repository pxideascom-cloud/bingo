# The Bingo Club

A real-time, two-player Bingo game built with **HTML, CSS, JavaScript and a Python FastAPI server**. Create a private room, share the invitation link, and play from two browsers or devices. No accounts or frontend build step required.

## Run locally

Requires Python 3.10 or newer.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

Open **http://localhost:8000**. On macOS/Linux, use `.venv/bin/python` in place of `.\.venv\Scripts\python.exe`.

Create a room in one tab and join its six-character code in another tab to try both players. Each tab keeps its own seat in session storage. Two separate browser profiles or devices work too. Reloading a tab restores that player's original card.

### Play on two devices on the same Wi-Fi

1. Run the server on your computer.
2. Find your computer's local IPv4 address (`ipconfig` on Windows).
3. Open `http://YOUR_LOCAL_IP:8000` on **both** devices. Allow Python on your private network if Windows Firewall prompts you.
4. Create a room and share its invite link.

A link containing `localhost` only works on the computer running the server. Use the LAN address for Wi-Fi play or a public deployment URL for different networks.

## Put it online

This repository is ready to deploy; running it locally does not publish it to the internet.

### Render

1. Push the project to a Git repository you control.
2. In [Render](https://render.com/), create a **Blueprint** connected to that repository. The included `render.yaml` provides the settings. Alternatively, create a Python Web Service with build command `pip install -r requirements.txt` and start command `python server.py`.
3. Once deployed, open the public HTTPS URL. Create a room and send its invite link to your friend anywhere online.

Render supplies `PORT` and HTTPS. The browser automatically uses secure WebSockets (`wss://`) on HTTPS. Free services may sleep while idle and take time to wake; a restart clears current rooms. Hosting plans and availability depend on the provider.

### Docker or another Python host

```sh
docker build -t bingo-club .
docker run --rm -p 8000:8000 bingo-club
```

The server listens on `0.0.0.0:8000` by default. Override `HOST` or `PORT` through environment variables. Behind a reverse proxy, enable WebSocket upgrades and forward the original `Host` header. Use HTTPS for public play.

**Run exactly one server worker and one instance.** Rooms, cards, and session tokens live in process memory. Multiple independent workers cannot share matches; scaling would require shared storage and a pub/sub layer. Rooms do not survive a server restart.

## Rules

- Each player receives a shuffled 5 × 5 card containing every number from 1 to 25. There is no free center square.
- Shuffle as often as you want before marking yourself ready. Both players must be online and ready before the round starts.
- The room creator calls first in the first round. Players alternate calling an uncalled number by clicking their card.
- Each call automatically marks the number on **both** cards.
- Complete any row, column, or diagonal to earn a letter in **B–I–N–G–O**. The first player with at least five lines wins.
- If both players reach five lines on the same call, the round is a draw.
- Both players must request a rematch. Cards reset, and the starting player alternates between rounds.
- Disconnected players have five minutes to return to the same tab. A round pauses while someone is disconnected. Explicitly leaving, or a seat expiring, ends the current round and resets the remaining player to the lobby.

## Included

- Private, six-character room codes and copyable invite links
- Server-controlled boards, readiness, turns, scores, wins, and draws
- Live WebSocket updates, reconnects, and a heartbeat
- A two-seat limit, private cards, input checks, and basic request limits
- Responsive layout, keyboard controls, reduced-motion support, and optional sounds
- Win dialog, confetti, rematch voting, and clear connection states
- Backend tests, a real two-browser smoke test, and deployment files

## Verify

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
```

For the browser smoke test, keep the server running, then:

```powershell
.\.venv\Scripts\python.exe -m playwright install chromium
.\.venv\Scripts\python.exe tests/browser_smoke.py
```

On Windows with Microsoft Edge installed, the smoke test can use that browser without downloading Chromium:

```powershell
.\.venv\Scripts\python.exe tests/browser_smoke.py --channel msedge
```

Screenshots are saved under `test-results/`. Use `--url http://localhost:PORT` for a different server address.

## Files

```text
server.py             HTTP endpoints, WebSockets, session lifecycle
game.py               Bingo rules and private game state
static/index.html     Browser interface and dialogs
static/style.css      Responsive styling and animations
static/app.js         Live client, interaction, sound, reconnection
tests/                Rule, API, WebSocket and browser tests
Dockerfile            Container deployment
render.yaml           Render deployment configuration
```
