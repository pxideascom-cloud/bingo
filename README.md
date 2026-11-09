# The Bingo Club

Real-time **Bingo for 2 players** and **Ludo for 2 or 4 players**, built with **HTML, CSS, JavaScript and a Python FastAPI server**. Create a private room, share the invitation link, and play from separate browsers or devices. No accounts or frontend build step required.

## Run locally

Requires Python 3.10 or newer.

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe server.py
```

Open **http://localhost:8000**. On macOS/Linux, use `.venv/bin/python` in place of `.\.venv\Scripts\python.exe`.

Use the **Bingo / Ludo** selector at the top of the page to choose a game. Ludo is also available directly at **http://localhost:8000/ludo**. When creating a Ludo room, choose **2 players** or **4 players**; everyone must join and press Ready before play begins.

Create a room in one tab and join its six-character code in the other tabs to try the players. Each tab keeps its own seat for each game in session storage. Separate browser profiles or devices work too. Reloading a tab restores that player's Bingo card or the shared Ludo board, including any pending dice roll. Invitation links open the correct game; entering a code on the other game's page also takes you to the right game.

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

## Bingo rules

- Each player starts with a shuffled 5 × 5 card containing every number from 1 to 25. There is no free center square.
- Keep the random card, shuffle again, or click **Choose numbers** before marking yourself ready. In manual setup, pick a square and then a number; the next empty square is selected automatically. Choosing an already placed number moves it or swaps the two squares. Fill all 25 squares and click **Save card**. Use **Edit numbers** to change a saved arrangement or **Shuffle card** to return to a random card.
- Both players must be online and ready before the round starts. Cards cannot change once a player is ready; use **Undo** in the lobby to unlock your card.
- The room creator calls first in the first round. Players alternate calling an uncalled number by clicking their card.
- Each call automatically marks the number on **both** cards.
- Complete any row, column, or diagonal to earn a letter in **B–I–N–G–O**. The first player with at least five lines wins.
- If both players reach five lines on the same call, the round is a draw.
- Both players must request a rematch. Cards reset, and the starting player alternates between rounds.
- **Room record** shows each player's total wins and draws, plus the last five round results. A draw adds no wins. Totals survive rematches, browser reloads, and reconnects in the same room; leaving keeps that seat's record visible, while joining again creates a new seat. An abandoned round adds no result. A new room starts at zero, and server restarts or room expiry clear the records.
- Disconnected players have five minutes to return to the same tab. A round pauses while someone is disconnected. Explicitly leaving, or a seat expiring, ends the current round and resets the remaining player to the lobby.

## Ludo rules

- The creator chooses exactly **2 or 4 players**. Two-player games use opposite red and yellow colors; four-player games use red, green, yellow, and blue. All seats must be filled, connected, and ready before the round starts.
- Each player has four tokens. On your turn, press **Roll dice**, then select a highlighted token on the board or one of the **Token 1–4** buttons below the dice. The server generates the roll and checks the move.
- Roll a **six** to move a token out of its yard onto its colored starting square. Other rolls move an active token forward by that many squares. A token in the yard cannot move on another number.
- Landing on an opponent on an ordinary track square sends their token back to its yard. The eight starred squares, including all four starting squares, are safe. Tokens may share squares; this version has no blockades. Landing on an unsafe stack captures all opposing tokens in that square.
- After traveling around the board, a token enters its own colored home lane. An **exact roll** is required to bring it home. The first player to bring all four tokens home wins.
- A six, a capture, or a token reaching home grants another roll. Three consecutive sixes end the turn; the third roll is discarded without moving a token. If there is no legal move, the turn passes automatically, except that a six still grants another roll.
- The room creator starts round one. Turns follow red → green → yellow → blue (red → yellow for two players), and the starting player rotates on each rematch. **Every player** must vote for a rematch.
- The **Room record** keeps each seat's wins and the last five round results. Reloading, reconnecting, and rematches keep the totals. Departed seats remain in the record; a replacement starts with zero wins. Abandoned rounds add no win.
- A disconnected player pauses the whole game and has five minutes to return in the same tab. Leaving or an expired seat resets the remaining players to the lobby so a replacement can join. Rooms and records are cleared on expiry or server restart.

## Included

- Private, six-character room codes and copyable invite links
- Server-controlled boards, readiness, turns, scores, wins, and draws
- Manual number placement with complete-card validation and private arrangements
- Room win/draw totals and recent round history preserved across rematches
- Live WebSocket updates, reconnects, and a heartbeat
- Two-seat Bingo rooms and two- or four-seat Ludo rooms, input checks, and basic request limits
- A responsive Ludo board with safe squares, captures, dice, legal token choices, and home progress
- Responsive layout, keyboard controls, reduced-motion support, and optional sounds
- Win dialog, confetti, rematch voting, and clear connection states
- Backend tests, real browser tests for both games and all Ludo room sizes, and deployment files

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
.\.venv\Scripts\python.exe tests/ludo_browser_smoke.py --channel msedge
```

The Ludo smoke test plays a complete two-player game, checks its rematch and win record, then exercises four-player rooms, mobile play, reconnects, and game routing. Screenshots are saved under `test-results/`. Use `--url http://localhost:PORT` for a different server address. Omit `--channel` to use Playwright's installed Chromium.

## Files

```text
server.py             HTTP endpoints, WebSockets, session lifecycle
game.py               Bingo rules and private game state
ludo.py               Ludo rules, board layout, dice, tokens, and room records
static/index.html     Browser interface and dialogs
static/style.css      Responsive styling and animations
static/app.js         Live client, interaction, sound, reconnection
static/ludo.html      Ludo room setup, board, controls, and dialogs
static/ludo.css       Ludo board, colored tokens, and responsive layout
static/ludo.js        Ludo live client, dice and token controls, reconnection
tests/                Rule, API, WebSocket and browser tests
Dockerfile            Container deployment
render.yaml           Render deployment configuration
```
