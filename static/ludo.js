"use strict";

const $ = (id) => document.getElementById(id);
const SEAT_KEY = "ludo-club-seat";
const COLORS = ["red", "green", "yellow", "blue"];
let ludoSeat = readStorage(sessionStorage, SEAT_KEY, null);
let ludoState = null;
let layout = null;
let socket = null;
let connected = false;
let pending = false;
let entryMode = "create";
let reconnectTimer = null;
let heartbeatTimer = null;
let actionTimer = null;
let toastTimer = null;
let reconnectAttempts = 0;
let lastPong = 0;
let resultShown = "";
const boardTokens = new Map();

function readStorage(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function saveStorage(storage, key, value) {
  try { value === null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* The current page still works. */ }
}

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}

function setMode(mode, focus = false) {
  entryMode = mode;
  for (const tabMode of ["create", "join"]) {
    const selected = tabMode === mode;
    $(`${tabMode}-tab`).classList.toggle("active", selected);
    $(`${tabMode}-tab`).setAttribute("aria-selected", String(selected));
    $(`${tabMode}-tab`).tabIndex = selected ? 0 : -1;
  }
  $("entry-form").setAttribute("aria-labelledby", `${mode}-tab`);
  $("seat-options").hidden = mode !== "create";
  $("room-code-field").hidden = mode !== "join";
  $("room-code").required = mode === "join";
  $("entry-submit").firstElementChild.textContent = mode === "create" ? "Create a room" : "Join the room";
  $("form-error").hidden = true;
  if (focus) $(`${mode}-tab`).focus();
}

for (const mode of ["create", "join"]) {
  $(`${mode}-tab`).addEventListener("click", () => setMode(mode));
  $(`${mode}-tab`).addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setMode(event.key === "Home" ? "create" : event.key === "End" ? "join" : entryMode === "create" ? "join" : "create", true);
  });
}
$("room-code").addEventListener("input", (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""); });
document.querySelectorAll("input[name=player-count]").forEach((input) => input.addEventListener("change", render));

$("entry-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("entry-submit").disabled) return;
  const name = $("player-name").value.trim().replace(/\s+/g, " ");
  const code = $("room-code").value.trim().toUpperCase();
  if (!name) { $("player-name").setCustomValidity("Please enter your name."); $("player-name").reportValidity(); return; }
  $("entry-submit").disabled = true;
  $("form-error").hidden = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const body = entryMode === "create" ? { name, game: "ludo", player_count: Number(document.querySelector("input[name=player-count]:checked").value) } : { name };
    const response = await fetch(entryMode === "create" ? "/api/rooms" : `/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
    });
    const seat = await response.json();
    if (!response.ok) throw new Error(typeof seat.detail === "string" ? seat.detail : "Please check your name and room settings.");
    saveStorage(localStorage, "bingo-club-name", name);
    if (seat.game !== "ludo") {
      saveStorage(sessionStorage, "bingo-club-seat", seat);
      location.replace(`/?room=${encodeURIComponent(seat.code)}`);
      return;
    }
    ludoSeat = seat;
    ludoState = null;
    saveStorage(sessionStorage, SEAT_KEY, seat);
    history.replaceState(null, "", `/ludo?room=${encodeURIComponent(seat.code)}`);
    connect();
  } catch (error) {
    $("form-error").textContent = error.name === "AbortError" ? "The server is taking a moment. Please try again." : error instanceof TypeError ? "Couldn't reach the server. Check your connection." : error.message;
    $("form-error").hidden = false;
  } finally {
    clearTimeout(timeout);
    $("entry-submit").disabled = false;
  }
});
$("player-name").addEventListener("input", () => $("player-name").setCustomValidity(""));

function buildBoard(boardLayout) {
  if (layout) return;
  layout = boardLayout;
  const board = $("ludo-board");
  board.replaceChildren();
  for (const color of COLORS) {
    const yard = document.createElement("div");
    yard.className = `ludo-yard ${color}`;
    yard.dataset.color = color;
    yard.setAttribute("aria-hidden", "true");
    board.append(yard);
  }
  const track = new Map(layout.track.map((cell, index) => [cell.join(","), index]));
  const home = new Map(COLORS.flatMap((color) => layout.home_lanes[color].slice(0, 5).map((cell) => [cell.join(","), color])));
  for (let row = 0; row < 15; row++) {
    for (let col = 0; col < 15; col++) {
      const square = document.createElement("div");
      square.className = "ludo-square";
      square.style.gridRow = row + 1;
      square.style.gridColumn = col + 1;
      square.setAttribute("aria-hidden", "true");
      const key = `${row},${col}`;
      const trackIndex = track.get(key);
      if (trackIndex !== undefined) {
        square.classList.add("track");
        if (layout.safe_squares.includes(trackIndex)) { square.classList.add("safe"); square.textContent = "★"; }
        const startColor = COLORS.find((color) => layout.starts[color] === trackIndex);
        if (startColor) square.classList.add(startColor);
      }
      if (home.has(key)) square.classList.add(home.get(key));
      board.append(square);
    }
  }
  const center = document.createElement("div");
  center.className = "ludo-center";
  center.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = "HOME";
  center.append(label);
  board.append(center);
}

function tokenStatus(progress) {
  return progress === -1 ? "In yard" : progress === 56 ? "Home" : progress >= 51 ? "Home lane" : "On track";
}

function renderTokens() {
  if (!layout) return;
  const count = ludoState?.player_count || Number(document.querySelector("input[name=player-count]:checked").value);
  const activeColors = count === 2 ? ["red", "yellow"] : COLORS;
  document.querySelectorAll(".ludo-yard").forEach((yard) => yard.classList.toggle("inactive", !activeColors.includes(yard.dataset.color)));
  const players = ludoState?.players || COLORS.map((color) => ({ id: `preview-${color}`, name: color, color,
    tokens: layout.yards[color].map((cell, index) => ({ cell, index, progress: -1 })) }));
  const liveKeys = new Set();
  const groups = new Map();
  for (const player of players) {
    for (const token of player.tokens) {
      const key = `${player.id}-${token.index}`;
      liveKeys.add(key);
      const groupKey = token.cell.join(",");
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ player, token, key });
    }
  }
  for (const group of groups.values()) {
    group.forEach(({ player, token, key }, slot) => {
      let button = boardTokens.get(key);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.addEventListener("click", () => sendAction({ type: "move", token_index: token.index }));
        boardTokens.set(key, button);
        $("ludo-board").append(button);
      }
      const movable = connected && !pending && player.id === ludoState?.you && ludoState.legal_moves.includes(token.index);
      button.className = `ludo-token ${player.color}${movable ? " movable" : ""}${token.progress === 56 ? " home" : ""}${!ludoState ? " preview" : ""}`;
      button.textContent = token.index + 1;
      button.disabled = !movable;
      button.dataset.playerId = player.id;
      button.dataset.tokenIndex = token.index;
      button.dataset.progress = token.progress;
      button.setAttribute("aria-label", `${player.name}'s ${player.color} token ${token.index + 1}: ${tokenStatus(token.progress)}${movable ? ", move this token" : ""}`);
      const columns = Math.ceil(Math.sqrt(group.length));
      const rows = Math.ceil(group.length / columns);
      const offsetX = (slot % columns - (columns - 1) / 2) * 0.32;
      const offsetY = (Math.floor(slot / columns) - (rows - 1) / 2) * 0.32;
      button.style.left = `${(token.cell[1] + 0.5 + offsetX) / 15 * 100}%`;
      button.style.top = `${(token.cell[0] + 0.5 + offsetY) / 15 * 100}%`;
      button.style.width = button.style.height = group.length > 4 ? "3.6%" : "5.1%";
    });
  }
  for (const [key, button] of boardTokens) {
    if (!liveKeys.has(key)) { button.remove(); boardTokens.delete(key); }
  }
}

function renderDice(value) {
  const dice = $("dice");
  dice.replaceChildren();
  dice.dataset.value = value ?? "";
  dice.setAttribute("aria-label", value ? `Dice: ${value}` : "No roll yet");
  if (!value) { const span = document.createElement("span"); span.textContent = "?"; dice.append(span); return; }
  const pips = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[value];
  for (const index of pips) {
    const pip = document.createElement("i");
    pip.style.gridRow = Math.floor(index / 3) + 1;
    pip.style.gridColumn = index % 3 + 1;
    dice.append(pip);
  }
}

function renderPlayers() {
  $("roster").replaceChildren();
  $("player-progress").replaceChildren();
  const count = ludoState?.player_count || ludoSeat?.player_count || 2;
  const colors = count === 2 ? ["red", "yellow"] : COLORS;
  for (const color of colors) {
    const player = ludoState?.players.find((p) => p.color === color);
    const row = document.createElement("div");
    row.className = "player-row";
    const dot = document.createElement("span");
    dot.className = `color-dot ${color}`;
    const details = document.createElement("div");
    details.className = "player-details";
    const name = document.createElement("strong");
    name.textContent = player ? `${player.name}${player.id === ludoState.you ? " (you)" : ""}` : `${color[0].toUpperCase() + color.slice(1)} seat open`;
    const status = document.createElement("small");
    status.textContent = !player ? "Invite a friend" : !player.connected ? "Reconnecting…" : ludoState.phase === "waiting" ? player.ready ? "Ready ✓" : "Getting ready" : player.id === ludoState.turn_id ? "Taking a turn" : "At the table";
    details.append(name, status);
    row.append(dot, details);
    $("roster").append(row);
    if (!player) continue;
    const progress = document.createElement("div");
    progress.className = `ludo-progress-row${player.id === ludoState.turn_id ? " current" : ""}`;
    const header = document.createElement("div");
    header.className = "ludo-progress-name";
    const progressName = document.createElement("span");
    progressName.textContent = name.textContent;
    const total = document.createElement("strong");
    total.textContent = `${player.tokens.filter((token) => token.progress === 56).length}/4 home`;
    header.append(dot.cloneNode(), progressName, total);
    const tokens = document.createElement("div");
    tokens.className = "ludo-progress-tokens";
    for (const token of player.tokens) {
      const label = document.createElement("span");
      label.textContent = tokenStatus(token.progress);
      label.classList.toggle("finished", token.progress === 56);
      tokens.append(label);
    }
    progress.append(header, tokens);
    $("player-progress").append(progress);
  }
  if (!ludoState) $("player-progress").textContent = "Invite your friends to begin the race.";
}

function renderRecord() {
  $("room-record").hidden = !ludoState;
  if (!ludoState) return;
  $("record-summary").textContent = `${ludoState.results.length} completed round${ludoState.results.length === 1 ? "" : "s"}`;
  $("record-players").replaceChildren();
  for (const record of ludoState.standings) {
    const row = document.createElement("tr");
    const name = document.createElement("th");
    name.scope = "row";
    const active = ludoState.players.some((p) => p.id === record.id);
    name.textContent = `${record.name}${record.id === ludoState.you ? " (you)" : active ? "" : " (left)"}`;
    const wins = document.createElement("td");
    wins.textContent = record.wins;
    row.append(name, wins);
    $("record-players").append(row);
  }
  $("round-history").hidden = ludoState.results.length === 0;
  $("round-results").replaceChildren();
  for (const result of ludoState.results.slice(-5).reverse()) {
    const item = document.createElement("li");
    item.textContent = `Round ${String(result.round).padStart(2, "0")} · ${result.winner_name} won · ${result.rolls} rolls`;
    $("round-results").append(item);
  }
}

function render() {
  document.body.classList.toggle("in-room", Boolean(ludoSeat));
  document.body.classList.toggle("is-playing", ludoState?.phase === "playing" || ludoState?.phase === "finished");
  $("entry-panel").hidden = Boolean(ludoSeat);
  $("room-panel").hidden = !ludoSeat;
  const me = ludoState?.players.find((p) => p.id === ludoState.you);
  const current = ludoState?.players.find((p) => p.id === ludoState.turn_id);
  const myTurn = connected && ludoState?.phase === "playing" && !ludoState.paused && current?.id === me?.id;
  $("ludo-board").dataset.phase = ludoState?.phase || "preview";
  $("ludo-board").dataset.revision = ludoState?.revision ?? "";
  $("board-status").classList.toggle("your-turn", Boolean(myTurn));
  $("board-status").classList.toggle("paused", Boolean(ludoSeat && (!connected || ludoState?.paused)));
  $("color-label").textContent = me ? `YOU ARE ${me.color.toUpperCase()}` : "2 OR 4 PLAYERS";
  $("board-eyebrow").textContent = ludoState ? `ROUND ${String(ludoState.round).padStart(2, "0")} · THE RACE HOME` : "THE RACE HOME";
  let status = "Create or join a room to play.";
  if (ludoSeat && !connected) status = ludoState ? "Connection lost. Reconnecting to your table…" : "Connecting to your table…";
  else if (ludoState?.phase === "waiting") status = `${ludoState.players.length} / ${ludoState.player_count} players here. ${me?.ready ? "You're ready!" : "Get everyone ready to start."}`;
  else if (ludoState?.phase === "playing") status = ludoState.paused ? "Game paused. Waiting for a player to reconnect…" : myTurn ? ludoState.dice ? "Your turn. Choose a highlighted token." : "Your turn. Roll the dice!" : `${current.name}'s turn. Watch the race.`;
  else if (ludoState?.phase === "finished") status = `${ludoState.players.find((p) => ludoState.winner_ids.includes(p.id)).name} brought every token home!`;
  $("board-status-text").textContent = status;
  $("roll-button").disabled = !myTurn || pending || ludoState.dice !== null;
  $("roll-button").textContent = myTurn && ludoState.dice !== null ? "Choose a token" : "Roll dice";
  const lastRoller = ludoState?.players.find((p) => p.id === ludoState.last_roll_player_id);
  $("roll-caption").textContent = lastRoller ? `${lastRoller.id === me?.id ? "You" : lastRoller.name} rolled ${ludoState.last_roll}` : "A little luck goes a long way.";
  $("last-action").textContent = ludoState?.last_action || "Roll a six to bring a token onto the track.";
  renderDice(ludoState?.last_roll);
  renderTokens();
  renderPlayers();
  renderRecord();
  $("token-choices").replaceChildren();
  if (me) {
    for (const token of me.tokens) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "token-choice";
      button.disabled = !myTurn || pending || !ludoState.legal_moves.includes(token.index);
      button.append(document.createTextNode(`Token ${token.index + 1}`));
      const label = document.createElement("small");
      label.textContent = tokenStatus(token.progress);
      button.append(label);
      button.addEventListener("click", () => sendAction({ type: "move", token_index: token.index }));
      $("token-choices").append(button);
    }
  }
  if (ludoSeat) {
    const count = ludoState?.player_count || ludoSeat.player_count;
    $("room-heading").textContent = count === 4 ? "Room for four." : "Room for two.";
    $("invite-code").textContent = ludoSeat.code;
    $("round-label").textContent = `ROUND ${String(ludoState?.round || 1).padStart(2, "0")}`;
    const open = count - (ludoState?.players.length || 1);
    $("invite-hint").textContent = open ? `Share the link. ${open} seat${open === 1 ? "" : "s"} still open.` : "Your table is full. Let the race begin.";
    $("room-notice").hidden = !ludoState?.notice;
    $("room-notice").textContent = ludoState?.notice || "";
    $("ready-button").disabled = !connected || pending;
    if (ludoState?.phase === "waiting") {
      $("ready-button").textContent = me?.ready ? "Ready ✓ · Undo" : "I'm ready ✓";
      $("ready-note").textContent = `All ${count} players must be online and ready.`;
    } else if (ludoState?.phase === "finished") {
      $("ready-button").textContent = me?.rematch ? "Rematch requested ✓" : "Play again ↗";
      $("ready-button").disabled ||= me?.rematch;
      $("ready-note").textContent = `${ludoState.players.filter((p) => p.rematch).length} / ${count} rematch votes.`;
    } else {
      $("ready-button").textContent = ludoState?.paused ? "Game paused" : "View the board ↗";
      $("ready-note").textContent = ludoState?.paused ? "Disconnected players have five minutes to return." : "Roll and move directly on your board.";
    }
    $("confirm-leave").disabled = !connected || pending;
  }
  if (ludoState?.phase === "finished") {
    const winner = ludoState.players.find((p) => ludoState.winner_ids.includes(p.id));
    $("result-title").textContent = winner.id === me.id ? "All the way home!" : `${winner.name} wins!`;
    $("result-description").textContent = "Four tokens safely home. Everyone can choose Play again for another race.";
    $("result-record").textContent = `Room wins: ${ludoState.players.map((p) => `${p.name} ${p.wins}`).join(" · ")}`;
    $("rematch-button").disabled = !connected || pending || me.rematch;
    $("rematch-button").textContent = me.rematch ? `Waiting for players… ${ludoState.players.filter((p) => p.rematch).length}/${ludoState.player_count}` : "Play again ↗";
    const key = `${ludoState.code}-${ludoState.round}`;
    if (resultShown !== key) { resultShown = key; $("result-dialog").showModal(); }
  } else $("result-dialog").close();
  document.title = myTurn ? "Your turn! — Ludo" : ludoSeat ? `${ludoSeat.code} — Ludo` : "Ludo — The Bingo Club";
}

function connect() {
  if (!ludoSeat) return;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(actionTimer);
  connected = pending = false;
  render();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/${encodeURIComponent(ludoSeat.code)}`);
  socket = ws;
  ws.addEventListener("open", () => {
    if (socket !== ws || !ludoSeat) { ws.close(); return; }
    ws.send(JSON.stringify({ token: ludoSeat.token }));
    lastPong = Date.now();
    heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 45000) { ws.close(); return; }
      ws.send(JSON.stringify({ type: "ping" }));
    }, 15000);
  });
  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    lastPong = Date.now();
    if (message.type === "state") {
      if (message.game !== "ludo") { saveStorage(sessionStorage, "bingo-club-seat", ludoSeat); saveStorage(sessionStorage, SEAT_KEY, null); location.replace(`/?room=${ludoSeat.code}`); return; }
      if (ludoState?.code === message.code && ludoState.revision > message.revision) return;
      const previous = ludoState;
      ludoState = message;
      connected = true;
      pending = false;
      reconnectAttempts = 0;
      clearTimeout(actionTimer);
      buildBoard(message.layout);
      render();
      if (previous?.phase === "waiting" && message.phase === "playing" && matchMedia("(max-width: 640px)").matches) $("board-title").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    } else if (message.type === "error") {
      pending = false;
      clearTimeout(actionTimer);
      render();
      toast(message.message);
    } else if (message.type === "expired" || message.type === "left") {
      resetSeat();
      toast(message.type === "left" ? "You left the Ludo room." : message.message);
    }
  });
  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    clearInterval(heartbeatTimer);
    clearTimeout(actionTimer);
    connected = pending = false;
    if (event.code === 4001) { resetSeat(); toast("Your seat is open in another tab. Continue playing there."); return; }
    if (!ludoSeat) return;
    render();
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, Math.min(1500 * 1.6 ** (reconnectAttempts - 1), 10000));
  });
  ws.addEventListener("error", () => { /* Close triggers reconnection. */ });
}

function sendAction(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !connected) { toast("Reconnecting to your table. Just a moment…"); return; }
  if (pending) return;
  pending = true;
  socket.send(JSON.stringify(message));
  actionTimer = setTimeout(() => { pending = false; render(); toast("The connection is slow. Checking your game…"); socket?.close(); }, 7000);
  render();
}

function resetSeat() {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(actionTimer);
  const previousSocket = socket;
  socket = null;
  previousSocket?.close();
  ludoSeat = ludoState = null;
  connected = pending = false;
  reconnectAttempts = 0;
  resultShown = "";
  saveStorage(sessionStorage, SEAT_KEY, null);
  history.replaceState(null, "", "/ludo");
  $("leave-dialog").close();
  $("result-dialog").close();
  setMode("create");
  render();
}

$("roll-button").addEventListener("click", () => sendAction({ type: "roll" }));
$("ready-button").addEventListener("click", () => {
  const me = ludoState?.players.find((p) => p.id === ludoState.you);
  if (ludoState?.phase === "finished") sendAction({ type: "rematch" });
  else if (ludoState?.phase === "playing") $("board-title").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  else sendAction({ type: "ready", ready: !me?.ready });
});
$("rematch-button").addEventListener("click", () => sendAction({ type: "rematch" }));
$("view-board-button").addEventListener("click", () => $("result-dialog").close());
$("leave-button").addEventListener("click", () => { if (connected) $("leave-dialog").showModal(); else toast("Reconnecting. Your seat stays saved for five minutes."); });
$("stay-button").addEventListener("click", () => $("leave-dialog").close());
$("confirm-leave").addEventListener("click", () => sendAction({ type: "leave" }));
$("rules-button").addEventListener("click", () => $("rules-dialog").showModal());
for (const id of ["close-rules", "got-it"]) $(id).addEventListener("click", () => $("rules-dialog").close());
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.className = "clipboard-helper";
    input.setAttribute("readonly", "");
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    toast(copied ? message : `Copy this: ${text}`);
  }
}
$("copy-code").addEventListener("click", () => ludoSeat && copyText(ludoSeat.code, "Room code copied."));
$("copy-link").addEventListener("click", () => ludoSeat && copyText(`${location.origin}/ludo?room=${ludoSeat.code}`, "Invite link copied. Send it to your friends."));

$("player-name").value = readStorage(localStorage, "bingo-club-name", "");
const invite = new URLSearchParams(location.search).get("room");
if (invite && /^[A-Za-z2-9]{6}$/.test(invite)) { $("room-code").value = invite.toUpperCase(); setMode("join"); }
render();
fetch("/api/ludo/layout").then((response) => { if (!response.ok) throw new Error("Board unavailable"); return response.json(); }).then((boardLayout) => { buildBoard(boardLayout); render(); }).catch(() => toast("Couldn't load the board. Check the server connection and reload."));
if (ludoSeat) connect();
