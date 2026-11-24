"use strict";

const $ = (id) => document.getElementById(id);
const SEAT_KEY = "ludo-club-seat";
const SOUND_KEY = "ludo-club-sound";
const COLORS = ["red", "green", "yellow", "blue"];
const START_ARROWS = { red: "→", green: "↓", yellow: "←", blue: "↑" };
const VISUAL_YARDS = {
  red: [[1.963, 1.963], [1.963, 4.037], [4.037, 1.963], [4.037, 4.037]],
  green: [[1.963, 10.963], [1.963, 13.037], [4.037, 10.963], [4.037, 13.037]],
  yellow: [[10.963, 10.963], [10.963, 13.037], [13.037, 10.963], [13.037, 13.037]],
  blue: [[10.963, 1.963], [10.963, 4.037], [13.037, 1.963], [13.037, 4.037]],
};
const HOME_ENTRY_CELLS = {
  "7,0": { color: "red", arrow: "→" },
  "0,7": { color: "green", arrow: "↓" },
  "7,14": { color: "yellow", arrow: "←" },
  "14,7": { color: "blue", arrow: "↑" },
};

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
let calloutTimer = null;
let diceAnimTimer = null;
let autoMoveTimer = null;
let reconnectAttempts = 0;
let lastPong = 0;
let resultShown = "";
let soundEnabled = readStorage(localStorage, SOUND_KEY, true);
let audioCtx = null;

const boardTokens = new Map();
const boardSquares = new Map();
const prevProgress = new Map();
const activeHopTimers = new Map();

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function readStorage(storage, key, fallback) {
  try { return JSON.parse(storage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function saveStorage(storage, key, value) {
  try { value === null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch { /* The current page still works. */ }
}

/* ===== WEB AUDIO SYNTHESIZER (LUDO KING STYLE, ZERO EXTERNAL ASSETS) ===== */
function ensureAudio() {
  if (!soundEnabled) return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioCtx) audioCtx = new AudioContextClass();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

function tone(freq, startOffset, duration, type = "sine", volume = 0.12, endFreq = null) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), now + duration);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

const LudoAudio = {
  click() {
    tone(520, 0, 0.05, "triangle", 0.06, 660);
  },
  diceRoll() {
    const clicks = [0, 0.055, 0.115, 0.18, 0.255, 0.34];
    clicks.forEach((offset, i) => {
      tone(210 + (i % 3) * 65 + Math.random() * 40, offset, 0.045, "triangle", 0.08, 130);
    });
    tone(155, 0.39, 0.09, "sine", 0.11, 95);
  },
  six() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.055, 0.18, "triangle", 0.11));
  },
  hop(step = 0) {
    tone(360 + Math.min(step, 6) * 32, 0, 0.065, "sine", 0.095, 480 + Math.min(step, 6) * 32);
  },
  exitYard() {
    tone(392, 0, 0.11, "triangle", 0.11, 523.25);
    tone(523.25, 0.08, 0.16, "triangle", 0.12, 659.25);
  },
  safeSquare() {
    tone(880, 0, 0.14, "sine", 0.08);
    tone(1318.5, 0.07, 0.22, "sine", 0.07);
  },
  capture() {
    // Punchy impact bass boom + KO descending whistle + triumphant brass chime
    tone(145, 0, 0.18, "sine", 0.18, 48);
    tone(720, 0.02, 0.18, "sawtooth", 0.085, 190);
    tone(480, 0.14, 0.22, "sawtooth", 0.075, 110);
    tone(659.25, 0.24, 0.16, "triangle", 0.11);
    tone(880, 0.32, 0.18, "triangle", 0.12);
    tone(1174.66, 0.4, 0.26, "triangle", 0.12);
  },
  home() {
    [523.25, 659.25, 783.99, 987.77, 1046.5].forEach((f, i) => tone(f, i * 0.07, 0.24, "triangle", 0.12));
  },
  threeSixes() {
    tone(360, 0, 0.14, "sawtooth", 0.07, 300);
    tone(290, 0.15, 0.16, "sawtooth", 0.07, 220);
    tone(210, 0.32, 0.28, "sawtooth", 0.07, 140);
  },
  yourTurn() {
    tone(587.33, 0, 0.1, "sine", 0.06);
    tone(880, 0.09, 0.14, "sine", 0.065);
  },
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5, 1318.5];
    const times = [0, 0.1, 0.2, 0.32, 0.48, 0.6, 0.75];
    notes.forEach((f, i) => tone(f, times[i], i === notes.length - 1 ? 0.55 : 0.18, "triangle", 0.13));
  },
};

function updateSoundButton() {
  const btn = $("sound-toggle");
  if (!btn) return;
  btn.setAttribute("aria-pressed", String(soundEnabled));
  btn.querySelector(".sound-icon").textContent = soundEnabled ? "🔊" : "🔇";
  $("sound-toggle-label").textContent = soundEnabled ? "Sound On" : "Sound Off";
}

$("sound-toggle")?.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  saveStorage(localStorage, SOUND_KEY, soundEnabled);
  updateSoundButton();
  if (soundEnabled) LudoAudio.click();
});
updateSoundButton();

/* Unlock WebAudio on first user gesture */
window.addEventListener("pointerdown", () => { if (soundEnabled && !audioCtx) ensureAudio(); }, { once: true });

/* ===== CALLOUTS, FX & CONFETTI ===== */
function showCallout(text, variant = "") {
  if (prefersReducedMotion()) return;
  const el = $("board-callout");
  if (!el) return;
  clearTimeout(calloutTimer);
  el.textContent = text;
  el.className = `board-callout${variant ? ` ${variant}` : ""}`;
  el.hidden = false;
  // Restart animation cleanly
  void el.offsetWidth;
  calloutTimer = setTimeout(() => { el.hidden = true; }, 1350);
}

function spawnBoardRing(cell, variant = "") {
  if (prefersReducedMotion()) return;
  const layer = $("board-fx");
  if (!layer || !cell) return;
  const ring = document.createElement("div");
  ring.className = `fx-ring${variant ? ` ${variant}` : ""}`;
  ring.style.left = `${(cell[1] + 0.5) / 15 * 100}%`;
  ring.style.top = `${(cell[0] + 0.5) / 15 * 100}%`;
  layer.append(ring);
  setTimeout(() => ring.remove(), 780);
}

const COLOR_HEX = { red: "#ff4d48", green: "#1ed760", yellow: "#ffd44d", blue: "#4da1ff" };

function spawnSparks(cell, count = 14, palette = ["#ffd44d", "#ff6b35", "#ffffff"], stars = false) {
  if (prefersReducedMotion()) return;
  const layer = $("board-fx");
  if (!layer || !cell) return;
  const cx = `${(cell[1] + 0.5) / 15 * 100}%`;
  const cy = `${(cell[0] + 0.5) / 15 * 100}%`;
  for (let i = 0; i < count; i++) {
    const spark = document.createElement("span");
    spark.className = `fx-spark${stars ? " star" : ""}`;
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.35;
    const dist = 34 + Math.random() * 44;
    const color = palette[i % palette.length];
    spark.style.left = cx;
    spark.style.top = cy;
    spark.style.color = color;
    spark.style.background = color;
    spark.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    spark.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
    layer.append(spark);
    setTimeout(() => spark.remove(), 720);
  }
}

function triggerCaptureFX(cell, victimColor, attackerBtn) {
  if (prefersReducedMotion()) return;
  const layer = $("board-fx");
  if (layer && cell) {
    const flash = document.createElement("div");
    flash.className = "fx-flash";
    flash.style.left = `${(cell[1] + 0.5) / 15 * 100}%`;
    flash.style.top = `${(cell[0] + 0.5) / 15 * 100}%`;
    layer.append(flash);
    setTimeout(() => flash.remove(), 400);
  }
  spawnBoardRing(cell, "capture");
  spawnBoardRing(cell, "capture-outer");
  spawnSparks(cell, 16, [COLOR_HEX[victimColor] || "#ff4d48", "#ffd44d", "#ff7a29", "#ffffff"], true);

  const frame = $("ludo-board-frame");
  if (frame) {
    frame.classList.remove("board-shake");
    void frame.offsetWidth;
    frame.classList.add("board-shake");
    setTimeout(() => frame.classList.remove("board-shake"), 380);
  }
  if (attackerBtn) {
    attackerBtn.classList.remove("attacker-slam");
    void attackerBtn.offsetWidth;
    attackerBtn.classList.add("attacker-slam");
    setTimeout(() => attackerBtn.classList.remove("attacker-slam"), 460);
  }
  LudoAudio.capture();
  showCallout("CAPTURED! +1 ROLL 💥", "capture");
}

function triggerHomeFX() {
  if (prefersReducedMotion()) return;
  const center = document.querySelector(".ludo-center");
  if (center) {
    center.classList.remove("celebrate");
    void center.offsetWidth;
    center.classList.add("celebrate");
    setTimeout(() => center.classList.remove("celebrate"), 740);
  }
  spawnBoardRing([7, 7], "home");
  spawnBoardRing([7, 7], "capture-outer");
  spawnSparks([7, 7], 18, ["#ffd44d", "#fff6b0", "#ff9f1c", "#ffffff"], true);
  LudoAudio.home();
  showCallout("TOKEN HOME! +1 ROLL ♛");
}

function launchConfetti() {
  if (prefersReducedMotion()) return;
  const container = $("confetti");
  if (!container) return;
  container.replaceChildren();
  const palette = ["#e52521", "#00a844", "#f7c200", "#1677ff", "#ffd44d", "#ffffff"];
  for (let i = 0; i < 64; i++) {
    const piece = document.createElement("span");
    piece.className = "ludo-confetti-piece";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = palette[i % palette.length];
    piece.style.animationDelay = `${Math.random() * 0.9}s`;
    piece.style.animationDuration = `${2.2 + Math.random() * 1.4}s`;
    container.append(piece);
  }
  setTimeout(() => container.replaceChildren(), 4200);
}

function toast(message) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
}

function selectedEntryColor() {
  return document.querySelector("input[name=player-color]:checked")?.value || "auto";
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
  $("color-option-auto").hidden = mode !== "join";
  if (mode === "join") {
    const autoInput = document.querySelector("input[name=player-color][value=auto]");
    if (autoInput) autoInput.checked = true;
  } else if (selectedEntryColor() === "auto") {
    const redInput = document.querySelector("input[name=player-color][value=red]");
    if (redInput) redInput.checked = true;
  }
  $("entry-submit").firstElementChild.textContent = mode === "create" ? "Create a room" : "Join the room";
  $("form-error").hidden = true;
  render();
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
document.querySelectorAll("input[name=player-count], input[name=player-color]").forEach((input) => input.addEventListener("change", render));

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
    const chosenColor = selectedEntryColor();
    const colorPayload = chosenColor !== "auto" ? { color: chosenColor } : {};
    const body = entryMode === "create"
      ? { name, game: "ludo", player_count: Number(document.querySelector("input[name=player-count]:checked").value), ...colorPayload }
      : { name, ...colorPayload };
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
    prevProgress.clear();
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

/* ===== BOARD CONSTRUCTION ===== */
function buildBoard(boardLayout) {
  if (layout) return;
  layout = boardLayout;
  const board = $("ludo-board");
  board.replaceChildren();
  boardSquares.clear();

  for (const color of COLORS) {
    const yard = document.createElement("div");
    yard.className = `ludo-yard ${color}`;
    yard.dataset.color = color;
    yard.setAttribute("aria-hidden", "true");
    const pad = document.createElement("div");
    pad.className = "yard-pad";
    for (let i = 0; i < 4; i++) {
      const spot = document.createElement("span");
      spot.className = "yard-spot";
      pad.append(spot);
    }
    const nameBadge = document.createElement("span");
    nameBadge.className = "yard-name";
    yard.append(pad, nameBadge);
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
        const startColor = COLORS.find((color) => layout.starts[color] === trackIndex);
        if (startColor) {
          square.classList.add(startColor, "start-square");
          square.textContent = START_ARROWS[startColor];
        } else if (layout.safe_squares.includes(trackIndex)) {
          square.classList.add("safe");
          square.textContent = "★";
        } else if (HOME_ENTRY_CELLS[key]) {
          square.classList.add("home-entry", `home-entry-${HOME_ENTRY_CELLS[key].color}`);
          square.dataset.arrow = HOME_ENTRY_CELLS[key].arrow;
        }
      }
      if (home.has(key)) square.classList.add(home.get(key));
      board.append(square);
      boardSquares.set(key, square);
    }
  }

  const center = document.createElement("div");
  center.className = "ludo-center";
  center.setAttribute("aria-hidden", "true");
  const crown = document.createElement("span");
  crown.textContent = "♛";
  center.append(crown);
  board.append(center);
}

function cellForProgress(color, tokenIndex, progress) {
  if (!layout) return [7, 7];
  if (progress < 0) return VISUAL_YARDS[color][tokenIndex];
  if (progress <= 50) return layout.track[(layout.starts[color] + progress) % layout.track.length];
  return layout.home_lanes[color][Math.min(progress - 51, 5)];
}

function clearTargetHighlight() {
  document.querySelectorAll(".ludo-square.target-square").forEach((sq) => sq.classList.remove("target-square"));
  document.querySelectorAll(".ludo-token.choice-hover").forEach((t) => t.classList.remove("choice-hover"));
}

function highlightDestination(player, token) {
  clearTargetHighlight();
  if (!ludoState || !ludoState.dice || !ludoState.legal_moves.includes(token.index)) return;
  const nextProgress = token.progress === -1 ? 0 : token.progress + ludoState.dice;
  const dest = cellForProgress(player.color, token.index, nextProgress);
  const sq = boardSquares.get(dest.join(","));
  if (sq) sq.classList.add("target-square");
  const tokenBtn = boardTokens.get(`${player.id}-${token.index}`);
  if (tokenBtn) tokenBtn.classList.add("choice-hover");
}

function tokenStatus(progress) {
  return progress === -1 ? "In yard" : progress === 56 ? "Home" : progress >= 51 ? "Home lane" : "On track";
}

function cancelHop(key) {
  const timers = activeHopTimers.get(key);
  if (timers) {
    timers.forEach(clearTimeout);
    activeHopTimers.delete(key);
  }
}

function positionToken(button, cell, offsetX = 0, offsetY = 0, size = "5.4%", exact = false) {
  const col = exact ? cell[1] : cell[1] + 0.5;
  const row = exact ? cell[0] : cell[0] + 0.5;
  button.style.left = `${(col + offsetX) / 15 * 100}%`;
  button.style.top = `${(row + offsetY) / 15 * 100}%`;
  button.style.width = button.style.height = size;
}

function animateTokenHop(button, key, player, token, fromProgress, toProgress, finalOffsetX, finalOffsetY, finalSize, onLand = null) {
  cancelHop(key);
  const timers = [];
  const steps = toProgress - fromProgress;
  const stepMs = 115;

  for (let s = 1; s <= steps; s++) {
    const p = fromProgress + s;
    const isLast = s === steps;
    const cell = cellForProgress(player.color, token.index, p);
    const t = setTimeout(() => {
      button.classList.add("hopping");
      positionToken(button, cell, isLast ? finalOffsetX : 0, isLast ? finalOffsetY : 0, isLast ? finalSize : "5.4%");
      LudoAudio.hop(s - 1);
      const t2 = setTimeout(() => button.classList.remove("hopping"), 80);
      timers.push(t2);
      if (isLast) {
        activeHopTimers.delete(key);
        if (onLand) onLand();
        if (toProgress === 56) {
          triggerHomeFX();
        } else if (toProgress <= 50) {
          const trackIdx = (layout.starts[player.color] + toProgress) % layout.track.length;
          if (layout.safe_squares.includes(trackIdx)) {
            spawnBoardRing(cell, "safe");
            LudoAudio.safeSquare();
          }
        }
      }
    }, (s - 1) * stepMs);
    timers.push(t);
  }
  activeHopTimers.set(key, timers);
  return (steps - 1) * stepMs + 40;
}

function activeTableColors() {
  if (ludoState?.colors) return ludoState.colors;
  const count = ludoState?.player_count || Number(document.querySelector("input[name=player-count]:checked").value);
  if (count === 4) return COLORS;
  const chosen = selectedEntryColor();
  return (chosen === "green" || chosen === "blue") ? ["green", "blue"] : ["red", "yellow"];
}

function renderTokens() {
  if (!layout) return;
  const activeColors = activeTableColors();
  const currentTurnPlayer = ludoState?.phase === "playing" && !ludoState.paused
    ? ludoState.players.find((p) => p.id === ludoState.turn_id)
    : null;

  document.querySelectorAll(".ludo-yard").forEach((yard) => {
    const color = yard.dataset.color;
    yard.classList.toggle("inactive", !activeColors.includes(color));
    yard.classList.toggle("active-turn", currentTurnPlayer?.color === color);
    const player = ludoState?.players.find((p) => p.color === color);
    const badge = yard.querySelector(".yard-name");
    if (badge) badge.textContent = player ? player.name : "";
  });

  const players = ludoState?.players || COLORS.map((color) => ({
    id: `preview-${color}`, name: color, color,
    tokens: layout.yards[color].map((cell, index) => ({ cell, index, progress: -1 })),
  }));

  const liveKeys = new Set();
  const groups = new Map();
  const capturedVictims = [];
  let attackerButton = null;
  let attackerImpactDelay = 0;

  for (const player of players) {
    for (const token of player.tokens) {
      const key = `${player.id}-${token.index}`;
      liveKeys.add(key);
      const groupKey = token.cell.join(",");
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ player, token, key });
    }
  }

  const reduced = prefersReducedMotion();

  for (const group of groups.values()) {
    group.forEach(({ player, token, key }, slot) => {
      let button = boardTokens.get(key);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.addEventListener("click", () => {
          clearTimeout(autoMoveTimer);
          clearTargetHighlight();
          sendAction({ type: "move", token_index: token.index });
        });
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

      button.onmouseenter = movable ? () => highlightDestination(player, token) : null;
      button.onmouseleave = movable ? clearTargetHighlight : null;

      const columns = Math.ceil(Math.sqrt(group.length));
      const rows = Math.ceil(group.length / columns);
      const offsetX = (slot % columns - (columns - 1) / 2) * 0.30;
      const offsetY = (Math.floor(slot / columns) - (rows - 1) / 2) * 0.30;
      const size = group.length > 4 ? "3.7%" : group.length > 1 ? "4.6%" : "5.4%";

      const inYard = token.progress < 0;
      const displayCell = inYard ? VISUAL_YARDS[player.color][token.index] : token.cell;
      const oldProg = prevProgress.get(key);
      if (ludoState && !reduced && oldProg !== undefined && oldProg !== token.progress) {
        if (oldProg === -1 && token.progress === 0) {
          cancelHop(key);
          positionToken(button, displayCell, offsetX, offsetY, size, false);
          button.classList.add("spawning");
          setTimeout(() => button.classList.remove("spawning"), 400);
          spawnBoardRing(displayCell, "spawn");
          spawnSparks(displayCell, 8, [COLOR_HEX[player.color] || "#ffd44d", "#ffffff"]);
          LudoAudio.exitYard();
        } else if (oldProg >= 0 && token.progress > oldProg && token.progress - oldProg <= 6) {
          attackerButton = button;
          attackerImpactDelay = animateTokenHop(button, key, player, token, oldProg, token.progress, offsetX, offsetY, size);
        } else if (oldProg >= 0 && token.progress === -1) {
          cancelHop(key);
          const oldCell = cellForProgress(player.color, token.index, oldProg);
          // Hold victim at capture square until attacker lands, then fly back dramatically!
          positionToken(button, oldCell, 0, 0, "5.4%", false);
          capturedVictims.push({ button, oldCell, yardCell: displayCell, color: player.color, key });
        } else {
          cancelHop(key);
          positionToken(button, displayCell, inYard ? 0 : offsetX, inYard ? 0 : offsetY, size, inYard);
        }
      } else if (!activeHopTimers.has(key)) {
        positionToken(button, displayCell, inYard ? 0 : offsetX, inYard ? 0 : offsetY, size, inYard);
      }

      if (ludoState) prevProgress.set(key, token.progress);
    });
  }

  if (capturedVictims.length > 0 && !reduced) {
    const impactDelay = attackerImpactDelay;
    const primary = capturedVictims[0];
    const impactTimer = setTimeout(() => {
      triggerCaptureFX(primary.oldCell, primary.color, attackerButton);
      for (const victim of capturedVictims) {
        victim.button.classList.add("victim-retreat");
        positionToken(victim.button, victim.yardCell, 0, 0, "5.4%", true);
        setTimeout(() => victim.button.classList.remove("victim-retreat"), 600);
      }
    }, impactDelay);
    activeHopTimers.set("__capture__", [impactTimer]);
  }

  for (const [key, button] of boardTokens) {
    if (!liveKeys.has(key)) {
      cancelHop(key);
      button.remove();
      boardTokens.delete(key);
      prevProgress.delete(key);
    }
  }
}

/* ===== 3D DICE RENDERING & ROLL ANIMATION ===== */
function drawDiceFace(value) {
  const dice = $("dice");
  dice.replaceChildren();
  dice.dataset.value = value ?? "";
  dice.setAttribute("aria-label", value ? `Dice: ${value}` : "No roll yet");
  if (!value) {
    const span = document.createElement("span");
    span.textContent = "?";
    dice.append(span);
    return;
  }
  const pips = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] }[value];
  for (const index of pips) {
    const pip = document.createElement("i");
    pip.style.gridRow = Math.floor(index / 3) + 1;
    pip.style.gridColumn = index % 3 + 1;
    dice.append(pip);
  }
}

function animateDiceRoll(finalValue, isThreeSixes = false) {
  const dice = $("dice");
  clearInterval(diceAnimTimer);
  dice.classList.remove("rolling", "settled", "rolled-six");

  if (!finalValue || prefersReducedMotion()) {
    drawDiceFace(finalValue);
    if (finalValue === 6 && !isThreeSixes) dice.classList.add("rolled-six");
    return;
  }

  LudoAudio.diceRoll();
  dice.classList.add("rolling");
  let ticks = 0;
  diceAnimTimer = setInterval(() => {
    ticks += 1;
    drawDiceFace(Math.floor(Math.random() * 6) + 1);
    if (ticks >= 7) {
      clearInterval(diceAnimTimer);
      diceAnimTimer = null;
      dice.classList.remove("rolling");
      drawDiceFace(finalValue);
      dice.classList.add("settled");
      setTimeout(() => dice.classList.remove("settled"), 300);
      if (isThreeSixes) {
        LudoAudio.threeSixes();
        showCallout("3 SIXES! TURN LOST", "bust");
      } else if (finalValue === 6) {
        dice.classList.add("rolled-six");
        LudoAudio.six();
        showCallout("SIX! ROLL AGAIN");
      }
    }
  }, 55);
}

function renderPlayers() {
  $("roster").replaceChildren();
  $("player-progress").replaceChildren();
  const colors = ludoState?.colors || ((ludoSeat?.player_count || 2) === 2 ? ["red", "yellow"] : COLORS);
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

function render(justRolled = false, isThreeSixes = false) {
  document.body.classList.toggle("in-room", Boolean(ludoSeat));
  document.body.classList.toggle("is-playing", ludoState?.phase === "playing" || ludoState?.phase === "finished");
  $("entry-panel").hidden = Boolean(ludoSeat);
  $("room-panel").hidden = !ludoSeat;
  const me = ludoState?.players.find((p) => p.id === ludoState.you);
  const current = ludoState?.players.find((p) => p.id === ludoState.turn_id);
  const myTurn = connected && ludoState?.phase === "playing" && !ludoState.paused && current?.id === me?.id;
  const canRoll = myTurn && !pending && ludoState.dice === null;

  $("ludo-board").dataset.phase = ludoState?.phase || "preview";
  $("ludo-board").dataset.revision = ludoState?.revision ?? "";
  $("board-status").classList.toggle("your-turn", Boolean(myTurn));
  $("board-status").classList.toggle("paused", Boolean(ludoSeat && (!connected || ludoState?.paused)));
  $("color-label").textContent = me ? `YOU ARE ${me.color.toUpperCase()}` : "2 OR 4 PLAYERS";
  $("board-eyebrow").textContent = ludoState ? `ROUND ${String(ludoState.round).padStart(2, "0")} · THE RACE HOME` : "THE RACE HOME";

  const tray = $("dice-tray");
  if (tray) {
    tray.className = `dice-tray${current && ludoState?.phase === "playing" ? ` turn-${current.color}` : ""}`;
  }
  $("dice").classList.toggle("roll-ready", canRoll);
  $("dice").disabled = !canRoll;

  const streakBadge = $("streak-badge");
  if (streakBadge) {
    const streak = ludoState?.six_streak || 0;
    streakBadge.hidden = streak <= 0;
    streakBadge.textContent = `6 × ${streak}`;
  }

  let status = "Create or join a room to play.";
  if (ludoSeat && !connected) status = ludoState ? "Connection lost. Reconnecting to your table…" : "Connecting to your table…";
  else if (ludoState?.phase === "waiting") status = `${ludoState.players.length} / ${ludoState.player_count} players here. ${me?.ready ? "You're ready!" : "Get everyone ready to start."}`;
  else if (ludoState?.phase === "playing") status = ludoState.paused ? "Game paused. Waiting for a player to reconnect…" : myTurn ? ludoState.dice ? "Your turn. Choose a highlighted token." : "Your turn. Roll the dice!" : `${current.name}'s turn. Watch the race.`;
  else if (ludoState?.phase === "finished") status = `${ludoState.players.find((p) => ludoState.winner_ids.includes(p.id)).name} brought every token home!`;
  $("board-status-text").textContent = status;

  $("roll-button").disabled = !canRoll;
  $("roll-button").textContent = myTurn && ludoState.dice !== null ? "Choose a token" : "Roll dice";

  const lastRoller = ludoState?.players.find((p) => p.id === ludoState.last_roll_player_id);
  $("roll-caption").textContent = lastRoller ? `${lastRoller.id === me?.id ? "You" : lastRoller.name} rolled ${ludoState.last_roll}` : "A little luck goes a long way.";
  $("last-action").textContent = ludoState?.last_action || "Roll a six to bring a token onto the track.";

  if (justRolled) {
    animateDiceRoll(ludoState?.last_roll, isThreeSixes);
  } else if (!diceAnimTimer) {
    drawDiceFace(ludoState?.last_roll);
    $("dice").classList.toggle("rolled-six", ludoState?.last_roll === 6 && ludoState?.dice === 6);
  }

  clearTargetHighlight();
  renderTokens();
  renderPlayers();
  renderRecord();

  $("token-choices").replaceChildren();
  if (me) {
    for (const token of me.tokens) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "token-choice";
      const movable = myTurn && !pending && ludoState.legal_moves.includes(token.index);
      button.disabled = !movable;
      button.append(document.createTextNode(`Token ${token.index + 1}`));
      const label = document.createElement("small");
      label.textContent = tokenStatus(token.progress);
      button.append(label);
      if (movable) {
        button.addEventListener("mouseenter", () => highlightDestination(me, token));
        button.addEventListener("mouseleave", clearTargetHighlight);
      }
      button.addEventListener("click", () => {
        clearTimeout(autoMoveTimer);
        clearTargetHighlight();
        sendAction({ type: "move", token_index: token.index });
      });
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
    const colorBlock = $("room-color-block");
    const colorGrid = $("room-color-grid");
    if (colorBlock && colorGrid) {
      const showPicker = Boolean(ludoState?.phase === "waiting" && me);
      colorBlock.hidden = !showPicker;
      if (showPicker) {
        colorGrid.replaceChildren();
        const canPickAnyPair = ludoState.player_count === 2 && ludoState.players.length === 1;
        const allowed = canPickAnyPair ? COLORS : (ludoState.colors || COLORS);
        for (const color of COLORS) {
          const btn = document.createElement("button");
          btn.type = "button";
          const isMine = me.color === color;
          const takenByOther = ludoState.players.some((p) => p.id !== me.id && p.color === color);
          const unavailable = !allowed.includes(color) || takenByOther;
          btn.className = `room-color-btn${isMine ? " selected" : ""}`;
          btn.disabled = !connected || pending || isMine || unavailable;
          btn.setAttribute("aria-pressed", String(isMine));
          const swatch = document.createElement("span");
          swatch.className = `color-swatch ${color}`;
          swatch.setAttribute("aria-hidden", "true");
          const label = document.createElement("span");
          label.textContent = color[0].toUpperCase() + color.slice(1);
          btn.append(swatch, label);
          btn.addEventListener("click", () => {
            LudoAudio.click();
            sendAction({ type: "color", color });
          });
          colorGrid.append(btn);
        }
      }
    }
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
    if (resultShown !== key) {
      resultShown = key;
      LudoAudio.win();
      launchConfetti();
      $("result-dialog").showModal();
    }
  } else {
    $("result-dialog").close();
  }

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

      const justRolled = Boolean(
        previous &&
        previous.phase === "playing" &&
        message.phase === "playing" &&
        message.last_roll !== null &&
        (message.dice !== null && previous.dice === null || message.last_action?.includes("rolled ")) &&
        previous.revision !== message.revision
      );
      const isThreeSixes = Boolean(justRolled && message.last_action?.includes("three sixes"));
      const becameMyTurn = Boolean(
        previous &&
        message.phase === "playing" &&
        !message.paused &&
        message.turn_id === message.you &&
        (previous.turn_id !== message.you || previous.phase !== "playing")
      );

      render(justRolled, isThreeSixes);
      if (becameMyTurn && !justRolled) LudoAudio.yourTurn();
      scheduleAutoMoveIfNoChoice(justRolled);

      if (previous?.phase === "waiting" && message.phase === "playing" && matchMedia("(max-width: 640px)").matches) {
        $("board-title").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      }
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

function singleForcedTokenIndex() {
  if (!connected || pending || !ludoState || ludoState.phase !== "playing" || ludoState.paused) return null;
  if (ludoState.turn_id !== ludoState.you || ludoState.dice === null) return null;
  const moves = ludoState.legal_moves;
  if (!moves || moves.length === 0) return null;
  // Auto-move only when there is literally one legal token (e.g. only one token outside on 1-5),
  // or when multiple legal tokens are stacked on the exact same board square (never in the yard, so players can pick which token to open).
  if (moves.length === 1) return moves[0];
  const me = ludoState.players.find((p) => p.id === ludoState.you);
  if (!me) return null;
  const firstProg = me.tokens[moves[0]]?.progress;
  if (firstProg >= 0 && moves.every((idx) => me.tokens[idx]?.progress === firstProg)) return moves[0];
  return null;
}

function scheduleAutoMoveIfNoChoice(justRolled = false) {
  clearTimeout(autoMoveTimer);
  autoMoveTimer = null;
  const forcedIndex = singleForcedTokenIndex();
  if (forcedIndex === null) return;
  const expectedRevision = ludoState.revision;
  const delay = prefersReducedMotion() ? 900 : (justRolled ? 470 : 200);
  if (!prefersReducedMotion()) {
    $("board-status-text").textContent = `Auto-moving token ${forcedIndex + 1}…`;
  }
  autoMoveTimer = setTimeout(() => {
    autoMoveTimer = null;
    if (!connected || pending || !ludoState || ludoState.revision !== expectedRevision) return;
    if (singleForcedTokenIndex() !== forcedIndex) return;
    clearTargetHighlight();
    sendAction({ type: "move", token_index: forcedIndex });
  }, delay);
}

function sendAction(message) {
  clearTimeout(autoMoveTimer);
  autoMoveTimer = null;
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
  clearTimeout(autoMoveTimer);
  autoMoveTimer = null;
  clearInterval(diceAnimTimer);
  diceAnimTimer = null;
  for (const key of activeHopTimers.keys()) cancelHop(key);
  prevProgress.clear();
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

function triggerRoll() {
  if ($("roll-button").disabled) return;
  sendAction({ type: "roll" });
}

$("roll-button").addEventListener("click", triggerRoll);
$("dice").addEventListener("click", triggerRoll);
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const tag = event.target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "A" || document.querySelector("dialog[open]")) return;
  if (!$("roll-button").disabled) {
    event.preventDefault();
    triggerRoll();
  }
});

$("ready-button").addEventListener("click", () => {
  LudoAudio.click();
  const me = ludoState?.players.find((p) => p.id === ludoState.you);
  if (ludoState?.phase === "finished") sendAction({ type: "rematch" });
  else if (ludoState?.phase === "playing") $("board-title").scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  else sendAction({ type: "ready", ready: !me?.ready });
});
$("rematch-button").addEventListener("click", () => { LudoAudio.click(); sendAction({ type: "rematch" }); });
$("view-board-button").addEventListener("click", () => $("result-dialog").close());
$("leave-button").addEventListener("click", () => { if (connected) $("leave-dialog").showModal(); else toast("Reconnecting. Your seat stays saved for five minutes."); });
$("stay-button").addEventListener("click", () => $("leave-dialog").close());
$("confirm-leave").addEventListener("click", () => sendAction({ type: "leave" }));
$("rules-button").addEventListener("click", () => { LudoAudio.click(); $("rules-dialog").showModal(); });
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
