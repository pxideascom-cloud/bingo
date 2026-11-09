"use strict";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "bingo-club-seat";
const PREVIEW = [7, 19, 3, 22, 11, 14, 1, 25, 8, 17, 23, 10, 16, 4, 21, 6, 18, 12, 20, 2, 15, 5, 24, 9, 13];
const elements = {};
for (const id of ["bingo-board", "number-tray", "entry-panel", "room-panel", "entry-form", "player-name", "room-code", "room-code-field", "entry-submit", "form-error", "create-tab", "join-tab", "invite-code", "roster", "ready-button", "ready-note", "room-notice", "board-status", "board-status-text", "shuffle-button", "board-hint", "result-dialog", "rematch-button", "leave-dialog", "toast"]) elements[id] = $(id);

let mode = "create";
let session = readStorage(sessionStorage, SESSION_KEY, null);
let state = null;
let socket = null;
let connected = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let actionTimer = null;
let actionPending = false;
let reconnectAttempts = 0;
let lastPong = 0;
let toastTimer = null;
let resultShown = "";
let soundEnabled = readStorage(localStorage, "bingo-club-sound", false);
let audioContext = null;
let manualBoard = Array(25).fill(null);
let manualIndex = 0;
let manualSavePending = false;

function readStorage(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function saveStorage(storage, key, value) {
  try { value === null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* The current tab still works if storage is unavailable. */ }
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4500);
}

function setMode(nextMode, focus = false) {
  mode = nextMode;
  for (const tabMode of ["create", "join"]) {
    const tab = elements[`${tabMode}-tab`];
    const selected = mode === tabMode;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  elements["entry-form"].setAttribute("aria-labelledby", `${mode}-tab`);
  elements["room-code-field"].hidden = mode !== "join";
  elements["room-code"].required = mode === "join";
  elements["entry-submit"].firstElementChild.textContent = mode === "create" ? "Create a room" : "Join the room";
  elements["form-error"].hidden = true;
  if (focus) elements[`${mode}-tab`].focus();
}

for (const tabMode of ["create", "join"]) {
  elements[`${tabMode}-tab`].addEventListener("click", () => setMode(tabMode));
  elements[`${tabMode}-tab`].addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setMode(event.key === "Home" ? "create" : event.key === "End" ? "join" : mode === "join" ? "create" : "join", true);
    }
  });
}

const cells = PREVIEW.map((number, index) => {
  const button = document.createElement("button");
  button.className = "board-cell";
  button.type = "button";
  button.textContent = number;
  button.disabled = true;
  button.setAttribute("aria-label", `Number ${number}`);
  button.addEventListener("click", () => {
    if (!state || button.disabled) return;
    sendAction({ type: "call", number: state.board[index] });
  });
  button.addEventListener("keydown", (event) => {
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 };
    const offset = offsets[event.key];
    if (!offset) return;
    event.preventDefault();
    let next = index + offset;
    while (next >= 0 && next < 25) {
      if (!cells[next].disabled) { cells[next].focus(); break; }
      next += offset;
    }
  });
  elements["bingo-board"].append(button);
  return button;
});

const tray = Array.from({ length: 25 }, (_, index) => {
  const span = document.createElement("span");
  span.className = "tray-number";
  span.textContent = index + 1;
  span.setAttribute("aria-label", `${index + 1}: not called`);
  elements["number-tray"].append(span);
  return span;
});

const manualCells = Array.from({ length: 25 }, (_, index) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "manual-cell";
  button.addEventListener("click", () => { manualIndex = index; renderManual(); });
  button.addEventListener("keydown", (event) => {
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -5, ArrowDown: 5 }[event.key];
    if (offset) {
      event.preventDefault();
      manualIndex = Math.max(0, Math.min(24, index + offset));
      renderManual();
      manualCells[manualIndex].focus();
    } else if (["Backspace", "Delete"].includes(event.key)) {
      event.preventDefault();
      manualBoard[index] = null;
      renderManual();
    }
  });
  $("manual-grid").append(button);
  return button;
});

const manualNumbers = Array.from({ length: 25 }, (_, index) => {
  const number = index + 1;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = number;
  button.addEventListener("click", () => {
    const previousIndex = manualBoard.indexOf(number);
    if (previousIndex !== -1) manualBoard[previousIndex] = manualBoard[manualIndex];
    manualBoard[manualIndex] = number;
    const nextEmpty = manualBoard.findIndex((value, i) => value === null && i > manualIndex);
    const firstEmpty = manualBoard.indexOf(null);
    if (nextEmpty !== -1 || firstEmpty !== -1) manualIndex = nextEmpty !== -1 ? nextEmpty : firstEmpty;
    $("manual-error").hidden = true;
    renderManual();
  });
  $("manual-numbers").append(button);
  return button;
});

function renderManual() {
  const me = state?.players.find((player) => player.id === state.you);
  const editable = connected && state?.phase === "waiting" && !me?.ready && !actionPending;
  manualCells.forEach((cell, index) => {
    cell.textContent = manualBoard[index] ?? "·";
    cell.disabled = !editable;
    cell.classList.toggle("selected", index === manualIndex);
    cell.classList.toggle("empty", manualBoard[index] === null);
    cell.setAttribute("aria-pressed", String(index === manualIndex));
    cell.setAttribute("aria-label", `Row ${Math.floor(index / 5) + 1}, column ${index % 5 + 1}: ${manualBoard[index] ?? "empty"}`);
  });
  manualNumbers.forEach((button, index) => {
    const used = manualBoard.includes(index + 1);
    button.disabled = !editable;
    button.classList.toggle("used", used);
    button.setAttribute("aria-pressed", String(used));
    button.setAttribute("aria-label", `${index + 1}${used ? ", already placed; choose to move or swap" : ", available"}`);
  });
  const count = manualBoard.filter((number) => number !== null).length;
  $("manual-count").textContent = `${count} / 25 placed`;
  $("save-manual").disabled = !editable || count !== 25;
  $("save-manual").textContent = manualSavePending ? "Saving…" : "Save card";
  $("clear-manual").disabled = !editable || count === 0;
  $("clear-manual-cell").disabled = !editable || manualBoard[manualIndex] === null;
}

$("manual-button").addEventListener("click", () => {
  manualBoard = state.board_mode === "manual" ? state.board.slice() : Array(25).fill(null);
  manualIndex = 0;
  manualSavePending = false;
  $("manual-error").hidden = true;
  renderManual();
  $("manual-dialog").showModal();
  manualCells[0].focus();
});
for (const id of ["close-manual", "cancel-manual"]) $(id).addEventListener("click", () => $("manual-dialog").close());
$("clear-manual").addEventListener("click", () => {
  manualBoard = Array(25).fill(null);
  manualIndex = 0;
  renderManual();
});
$("clear-manual-cell").addEventListener("click", () => { manualBoard[manualIndex] = null; renderManual(); });
$("save-manual").addEventListener("click", () => {
  manualSavePending = true;
  if (!sendAction({ type: "set_board", board: manualBoard.slice() })) manualSavePending = false;
  renderManual();
});

elements["room-code"].addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, "");
});

elements["entry-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (elements["entry-submit"].disabled) return;
  const name = elements["player-name"].value.trim().replace(/\s+/g, " ");
  const code = elements["room-code"].value.trim().toUpperCase();
  if (!name) {
    elements["player-name"].setCustomValidity("Please enter your name.");
    elements["player-name"].reportValidity();
    return;
  }
  const requestMode = mode;
  elements["entry-submit"].disabled = true;
  elements["entry-submit"].firstElementChild.textContent = requestMode === "create" ? "Setting your table…" : "Finding your table…";
  elements["form-error"].hidden = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(requestMode === "create" ? "/api/rooms" : `/api/rooms/${encodeURIComponent(code)}/join`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Please enter a name between 1 and 18 characters.");
    if (data.game === "ludo") {
      saveStorage(sessionStorage, "ludo-club-seat", data);
      location.replace(`/ludo?room=${encodeURIComponent(data.code)}`);
      return;
    }
    session = data;
    state = null;
    saveStorage(sessionStorage, SESSION_KEY, session);
    saveStorage(localStorage, "bingo-club-name", name);
    history.replaceState(null, "", `/?room=${encodeURIComponent(session.code)}`);
    connect();
  } catch (error) {
    elements["form-error"].textContent = error.name === "AbortError" ? "The server is taking a moment. Please try again." : error instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : error.message;
    elements["form-error"].hidden = false;
  } finally {
    clearTimeout(timeout);
    elements["entry-submit"].disabled = false;
    elements["entry-submit"].firstElementChild.textContent = mode === "create" ? "Create a room" : "Join the room";
  }
});
elements["player-name"].addEventListener("input", () => elements["player-name"].setCustomValidity(""));

function connect() {
  if (!session) return;
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  connected = false;
  actionPending = false;
  clearTimeout(actionTimer);
  render();
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/${encodeURIComponent(session.code)}`);
  socket = ws;
  ws.addEventListener("open", () => {
    if (socket !== ws || !session) { ws.close(); return; }
    ws.send(JSON.stringify({ type: "auth", token: session.token }));
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
      if (state && state.code === message.code && state.revision > message.revision) return;
      const previous = state;
      const wasConnected = connected;
      state = message;
      connected = true;
      reconnectAttempts = 0;
      actionPending = false;
      clearTimeout(actionTimer);
      if (manualSavePending && state.board_mode === "manual" && state.board.every((number, index) => number === manualBoard[index])) {
        manualSavePending = false;
        $("manual-dialog").close();
        showToast("Your chosen numbers are saved. Press Ready when you're set.");
      }
      render(previous);
      if (!wasConnected && previous) showToast("You're back. Your card was saved.");
      if (previous && previous.round === state.round && state.called.length > previous.called.length) {
        playTone(state.phase === "finished" ? "win" : "call");
      } else if (previous?.phase === "waiting" && state.phase === "playing") {
        playTone("start");
        if (window.matchMedia("(max-width: 640px)").matches) $("board-title").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      }
    } else if (message.type === "error") {
      actionPending = false;
      if (manualSavePending) {
        manualSavePending = false;
        $("manual-error").textContent = message.message;
        $("manual-error").hidden = false;
      }
      clearTimeout(actionTimer);
      render();
      showToast(message.message);
    } else if (message.type === "expired") {
      resetSession();
      showToast(message.message);
    } else if (message.type === "left") {
      resetSession();
      showToast("You left the room. Another round, another time.");
    }
  });
  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    clearInterval(heartbeatTimer);
    clearTimeout(actionTimer);
    connected = false;
    actionPending = false;
    manualSavePending = false;
    if (event.code === 4001) {
      resetSession();
      showToast("Your seat is open in another tab. Continue playing there.");
      return;
    }
    if (!session) return;
    render();
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(connect, Math.min(1500 * 1.6 ** (reconnectAttempts - 1), 10000));
  });
  ws.addEventListener("error", () => { /* Close triggers the automatic reconnect. */ });
}

function sendAction(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !connected) {
    showToast("Reconnecting to your table. Just a moment…");
    return false;
  }
  if (actionPending) return false;
  actionPending = true;
  socket.send(JSON.stringify(message));
  actionTimer = setTimeout(() => {
    actionPending = false;
    render();
    showToast("The connection is slow. Reconnecting to check your game…");
    socket?.close();
  }, 7000);
  render();
  return true;
}

function resetSession() {
  clearTimeout(reconnectTimer);
  clearTimeout(actionTimer);
  clearInterval(heartbeatTimer);
  const previousSocket = socket;
  socket = null;
  previousSocket?.close();
  session = null;
  state = null;
  connected = false;
  actionPending = false;
  resultShown = "";
  reconnectAttempts = 0;
  saveStorage(sessionStorage, SESSION_KEY, null);
  history.replaceState(null, "", "/");
  elements["leave-dialog"].close();
  elements["result-dialog"].close();
  $("manual-dialog").close();
  manualSavePending = false;
  setMode("create");
  render();
}

function render(previous = null) {
  document.body.classList.toggle("in-room", Boolean(session));
  document.body.classList.toggle("is-playing", state?.phase === "playing" || state?.phase === "finished");
  elements["entry-panel"].hidden = Boolean(session);
  elements["room-panel"].hidden = !session;
  const me = state?.players.find((p) => p.id === state.you);
  const opponent = state?.players.find((p) => p.id !== state.you);
  const called = new Set(state?.called || []);
  const board = state?.board || PREVIEW;
  const last = state?.called.at(-1);
  const complete = new Set(state?.completed_lines.flat() || []);
  const myTurn = connected && state?.phase === "playing" && !state.paused && state.turn_id === state.you;
  const canCall = myTurn && !actionPending;
  if (state?.phase !== "waiting" || me?.ready) $("manual-dialog").close();
  if ($("manual-dialog").open) renderManual();

  cells.forEach((cell, index) => {
    const number = board[index];
    const marked = called.has(number);
    cell.textContent = number;
    cell.disabled = !canCall || marked;
    cell.classList.toggle("marked", marked);
    cell.classList.toggle("complete", complete.has(index));
    cell.classList.toggle("last", last === number);
    cell.setAttribute("aria-label", `${number}${marked ? ", called" : ", not called"}${complete.has(index) ? ", completed line" : ""}`);
    cell.setAttribute("aria-pressed", String(marked));
    cell.title = !session ? "Create or join a room to play" : state?.phase === "waiting" ? "Your card is ready. Waiting for the game to start." : marked ? `${number} has been called` : myTurn ? `Call ${number}` : "Waiting for your turn";
    if (previous && last === number && previous.called.length < called.size) {
      cell.classList.remove("pop");
      void cell.offsetWidth;
      cell.classList.add("pop");
    }
  });
  tray.forEach((item, index) => {
    item.classList.toggle("called", called.has(index + 1));
    item.classList.toggle("latest", last === index + 1);
    item.setAttribute("aria-label", `${index + 1}: ${called.has(index + 1) ? "called" : "not called"}`);
  });

  const myLines = me?.lines || 0;
  const opponentLines = opponent?.lines || 0;
  updateProgress("bingo-letters", myLines, "Your progress");
  updateProgress("your-progress", myLines, "Your progress");
  updateProgress("opponent-progress", opponentLines, "Opponent progress");
  $("your-score-name").textContent = me ? `${me.name} (you)` : "You";
  $("opponent-score-name").textContent = opponent?.name || "Your future rival";
  updateCount("your-score-count", myLines);
  updateCount("opponent-score-count", opponentLines);
  renderRecord();
  $("called-count").textContent = `${called.size} / 25`;
  $("last-number").textContent = last ?? "–";
  $("last-number").classList.toggle("has-number", last !== undefined);
  const lastCall = state?.history.at(-1);
  $("last-caller").textContent = lastCall ? `${lastCall.player_id === state.you ? "You" : lastCall.name} called it` : "The suspense begins…";
  const recent = state?.history.slice(-4).reverse().map((call) => call.number).join(" · ");
  $("recent-calls").lastElementChild.textContent = recent ? `Recent calls: ${recent}` : "Every call marks both cards.";
  $("live-badge").lastChild.textContent = !session ? " STANDBY" : !connected ? " OFFLINE" : state?.paused ? " PAUSED" : " LIVE";
  $("live-badge").classList.toggle("is-live", connected && !state?.paused);
  $("card-tag").textContent = state ? `CARD ${state.players.findIndex((p) => p.id === state.you) + 1} / 2` : "1–25 EDITION";
  $("board-eyebrow").textContent = state?.phase === "playing" ? `ROUND ${String(state.round).padStart(2, "0")} · ${called.size} NUMBERS CALLED` : "THE PLAYING FIELD";
  elements["board-status"].classList.toggle("your-turn", Boolean(myTurn));
  elements["board-status"].classList.toggle("paused", Boolean(session && (!connected || state?.paused)));

  let status = "Your next game starts here.";
  let hint = "Create or join a room to get your card.";
  if (session && !connected) {
    status = state ? "Connection lost. Finding your table again…" : "Connecting to your table…";
    hint = "Your seat is saved for five minutes.";
  } else if (state?.phase === "waiting") {
    status = !opponent ? "A table for two. Invite your friend." : me?.ready ? `You're ready. Waiting for ${opponent.name}…` : "Like your card? Let your rival know you're ready.";
    hint = me?.ready ? "Card locked in. Looking lucky." : state.board_mode === "manual" ? "Your numbers, your arrangement." : "Keep it random or choose your numbers.";
  } else if (state?.phase === "playing") {
    status = state.paused ? "Game paused. Waiting for your rival to reconnect…" : myTurn ? "Your turn. Pick a number on your card." : `${opponent?.name || "Your rival"}'s turn. Your next move is coming.`;
    hint = `${myLines} of 5 lines complete · Every call marks both cards`;
  } else if (state?.phase === "finished") {
    status = state.winner_ids.length > 1 ? "A double Bingo! Great minds think alike." : state.winner_ids.includes(state.you) ? "BINGO! This round is all yours." : `BINGO! ${opponent?.name || "Your rival"} takes this round.`;
    hint = "Another round? Both players can choose Play again.";
  }
  elements["board-status-text"].textContent = status;
  elements["board-hint"].textContent = hint;
  elements["shuffle-button"].hidden = !state || state.phase !== "waiting";
  elements["shuffle-button"].disabled = !connected || actionPending || me?.ready;
  $("manual-button").hidden = !state || state.phase !== "waiting";
  $("manual-button").disabled = !connected || actionPending || me?.ready;
  $("manual-button").textContent = state?.board_mode === "manual" ? "Edit numbers" : "Choose numbers";
  document.title = !session ? "The Bingo Club — A game for two" : myTurn ? "Your turn! — The Bingo Club" : `${session.code} — The Bingo Club`;

  if (session) {
    elements["invite-code"].textContent = session.code;
    $("round-label").textContent = `ROUND ${String(state?.round || 1).padStart(2, "0")}`;
    $("invite-hint").textContent = opponent ? "Your table is full. Let the good games roll." : "Send the link to your friend to get started.";
    renderRoster(me, opponent);
    elements["room-notice"].hidden = !state?.notice;
    elements["room-notice"].textContent = state?.notice || "";
    const readyButton = elements["ready-button"];
    readyButton.disabled = !connected || actionPending;
    if (state?.phase === "playing") {
      readyButton.textContent = state.paused ? "Game paused" : myTurn ? "Go to my card ↗" : "View my card ↗";
      readyButton.disabled = !connected;
      elements["ready-note"].textContent = state.paused ? "Your rival has five minutes to return." : "Pick a number directly on your card.";
    } else if (state?.phase === "finished") {
      readyButton.textContent = me?.rematch ? "Rematch requested ✓" : "Play again ↗";
      readyButton.disabled ||= me?.rematch;
      elements["ready-note"].textContent = me?.rematch ? "Waiting for your rival to join the rematch." : opponent?.rematch ? "Your rival is ready for another round!" : "One more for the bragging rights?";
    } else {
      readyButton.textContent = !connected ? "Connecting…" : me?.ready ? "Ready ✓ · Undo" : "I'm ready ✓";
      elements["ready-note"].textContent = me?.ready ? "The game starts when both players are ready." : "Shuffle or choose your numbers, then press Ready.";
    }
    $("confirm-leave").disabled = !connected || actionPending;
  }

  if (state?.phase === "finished") {
    renderResult(me, opponent);
    const resultKey = `${state.code}-${state.round}`;
    if (resultShown !== resultKey) {
      resultShown = resultKey;
      elements["result-dialog"].showModal();
      if (state.winner_ids.includes(state.you)) celebrate();
    }
  } else {
    elements["result-dialog"].close();
  }
}

function updateProgress(id, count, label) {
  const element = $(id);
  Array.from(element.children).forEach((letter, index) => letter.classList.toggle("earned", index < count));
  element.setAttribute("aria-label", `${label}: ${count} of 5 lines`);
}

function renderRecord() {
  $("room-record").hidden = !state;
  if (!state) return;
  const results = state.results || [];
  const draws = state.draws || 0;
  $("record-summary").textContent = `${results.length} completed round${results.length === 1 ? "" : "s"} · ${draws} draw${draws === 1 ? "" : "s"}`;
  $("record-players").replaceChildren();
  for (const record of state.standings || []) {
    const row = document.createElement("tr");
    const name = document.createElement("th");
    name.scope = "row";
    const active = state.players.some((player) => player.id === record.id);
    name.textContent = `${record.name}${record.id === state.you ? " (you)" : active ? "" : " (left)"}`;
    const wins = document.createElement("td");
    wins.textContent = record.wins;
    const ties = document.createElement("td");
    ties.textContent = record.draws;
    row.append(name, wins, ties);
    $("record-players").append(row);
  }
  $("round-history").hidden = results.length === 0;
  $("round-results").replaceChildren();
  for (const result of results.slice(-5).reverse()) {
    const item = document.createElement("li");
    const winner = result.players.find((player) => player.id === result.winner_ids[0]);
    item.textContent = `Round ${String(result.round).padStart(2, "0")} · ${result.winner_ids.length > 1 ? "Draw" : `${winner.name} won`} · ${result.numbers_called} calls`;
    $("round-results").append(item);
  }
}

function updateCount(id, count) {
  const element = $(id);
  element.replaceChildren(document.createTextNode(String(count)));
  const span = document.createElement("span");
  span.textContent = "/5";
  element.append(span);
}

function renderRoster(me, opponent) {
  elements.roster.replaceChildren();
  for (const [index, player] of [me, opponent].entries()) {
    const row = document.createElement("div");
    row.className = "player-row";
    const avatar = document.createElement("div");
    avatar.className = `avatar${index === 1 ? " rival" : ""}${!player ? " empty" : ""}`;
    avatar.textContent = player ? Array.from(player.name)[0].toUpperCase() : "+";
    avatar.setAttribute("aria-hidden", "true");
    const details = document.createElement("div");
    details.className = "player-details";
    const name = document.createElement("strong");
    name.textContent = player ? `${player.name}${index === 0 ? " (you)" : ""}` : index === 0 ? "Your seat" : "Waiting for a friend";
    const status = document.createElement("small");
    const online = player && player.connected && (index !== 0 || connected);
    status.textContent = !player ? "One open seat" : !online ? "Reconnecting…" : state.phase === "waiting" ? player.ready ? "Ready to play" : "Choosing their luck" : state.phase === "finished" ? player.rematch ? "Wants a rematch" : "Round complete" : state.turn_id === player.id ? "Calling a number" : "Eyes on the card";
    details.append(name, status);
    const indicator = document.createElement("span");
    indicator.className = `player-indicator${online ? " online" : ""}${online && player.ready && state.phase === "waiting" ? " ready" : ""}`;
    if (online && player.ready && state.phase === "waiting") indicator.textContent = "✓";
    indicator.setAttribute("aria-hidden", "true");
    row.append(avatar, details, indicator);
    elements.roster.append(row);
  }
}

function renderResult(me, opponent) {
  const draw = state.winner_ids.length > 1;
  const won = state.winner_ids.includes(state.you);
  $("result-eyebrow").textContent = draw ? "GREAT MINDS. SAME BINGO." : won ? "A BEAUTIFUL LITTLE VICTORY" : "A RIVALRY WORTH REPEATING";
  $("result-title").textContent = draw ? "A perfect little tie." : won ? "Bingo, you did it!" : `${opponent?.name || "Your rival"} got Bingo!`;
  $("result-description").textContent = draw ? "You both reached five lines on the same call. Some rivalries are just that well matched." : won ? "Five lines and all the bragging rights. Give your rival a chance to win them back?" : "This round goes to your rival. The next lucky card could have your name on it.";
  $("result-record").textContent = `Room wins: ${me.name} ${me.wins || 0} · ${opponent.name} ${opponent.wins || 0} · Draws ${state.draws || 0}`;
  $("result-stats").replaceChildren();
  for (const [number, label] of [[me?.lines || 0, "Your lines"], [opponent?.lines || 0, "Rival's lines"], [state.called.length, "Numbers called"]]) {
    const item = document.createElement("div");
    item.className = "result-stat";
    const value = document.createElement("strong");
    value.textContent = number;
    const caption = document.createElement("span");
    caption.textContent = label;
    item.append(value, caption);
    $("result-stats").append(item);
  }
  elements["rematch-button"].disabled = !connected || actionPending || me?.rematch;
  elements["rematch-button"].textContent = me?.rematch ? "Waiting for your rival…" : opponent?.rematch ? "Accept rematch ↗" : "Play again ↗";
}

elements["shuffle-button"].addEventListener("click", () => sendAction({ type: "shuffle" }));
elements["ready-button"].addEventListener("click", () => {
  const me = state?.players.find((p) => p.id === state.you);
  if (state?.phase === "finished") sendAction({ type: "rematch" });
  else if (state?.phase === "playing") $("board-title").scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  else sendAction({ type: "ready", ready: !me?.ready });
});
elements["rematch-button"].addEventListener("click", () => sendAction({ type: "rematch" }));
$("view-board-button").addEventListener("click", () => elements["result-dialog"].close());
$("leave-button").addEventListener("click", () => {
  if (!connected) {
    showToast("Reconnecting. To release your seat now, close this tab; it expires in five minutes.");
    return;
  }
  elements["leave-dialog"].showModal();
});
$("stay-button").addEventListener("click", () => elements["leave-dialog"].close());
$("confirm-leave").addEventListener("click", () => sendAction({ type: "leave" }));
$("rules-button").addEventListener("click", () => $("rules-dialog").showModal());
$("close-rules").addEventListener("click", () => $("rules-dialog").close());
$("got-it").addEventListener("click", () => $("rules-dialog").close());
document.querySelector(".brand").addEventListener("click", (event) => {
  if (session) {
    event.preventDefault();
    if (connected) elements["leave-dialog"].showModal();
    else showToast("Reconnecting to your game…");
  }
});
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    }
  });
}

async function copyText(text, success) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(text);
    showToast(success);
  } catch {
    // LAN HTTP pages may not have the modern clipboard API.
    const input = document.createElement("textarea");
    input.value = text;
    input.className = "clipboard-helper";
    input.setAttribute("readonly", "");
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    showToast(copied ? success : `Copy this: ${text}`);
  }
}
$("copy-code").addEventListener("click", () => session && copyText(session.code, "Room code copied. Invite your rival!"));
$("copy-link").addEventListener("click", () => session && copyText(`${location.origin}/?room=${session.code}`, "Invite link copied. Send it to your friend."));

function updateSoundButton() {
  $("sound-button").setAttribute("aria-pressed", String(soundEnabled));
  $("sound-button").lastElementChild.textContent = soundEnabled ? "Sound on" : "Sound off";
  $("sound-wave").setAttribute("d", soundEnabled ? "M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" : "m16 9 6 6m0-6-6 6");
}
$("sound-button").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  saveStorage(localStorage, "bingo-club-sound", soundEnabled);
  updateSoundButton();
  if (soundEnabled) playTone("start");
});

function playTone(kind) {
  if (!soundEnabled) return;
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    audioContext ||= new Audio();
    audioContext.resume().catch(() => {});
    const notes = kind === "win" ? [523.25, 659.25, 783.99, 1046.5] : kind === "start" ? [523.25, 783.99] : [659.25];
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + index * 0.12;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.075, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.31);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    });
  } catch { /* Sound is optional on browsers without Web Audio. */ }
}

function celebrate() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const container = $("confetti");
  container.replaceChildren();
  for (let index = 0; index < 45; index++) {
    const piece = document.createElement("i");
    piece.className = "confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    piece.style.animationDuration = `${2 + Math.random() * 1.5}s`;
    container.append(piece);
  }
  setTimeout(() => container.replaceChildren(), 4500);
}

window.addEventListener("online", () => {
  if (session && !connected && socket?.readyState !== WebSocket.CONNECTING) connect();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted && session) connect();
});

elements["player-name"].value = readStorage(localStorage, "bingo-club-name", "");
const inviteCode = new URLSearchParams(location.search).get("room")?.trim().toUpperCase();
if (session && (typeof session.token !== "string" || typeof session.code !== "string" || (inviteCode && session.code !== inviteCode))) {
  session = null;
  saveStorage(sessionStorage, SESSION_KEY, null);
}
if (inviteCode && !session) {
  setMode("join");
  elements["room-code"].value = inviteCode.replace(/[^A-Z2-9]/g, "").slice(0, 6);
}
updateSoundButton();
render();
if (session) connect();
