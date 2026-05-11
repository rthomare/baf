// Entry point.
//
// One unified input surface: a draft composer + a joystick that does
// three jobs through gesture vocabulary:
//
//   tap   → commit the draft (send command + \r)
//   drag  → arrow key in the dominant direction (auto-repeat while held).
//           In block mode, ↑/↓ scrub composer history. In raw mode all
//           four go to the PTY.
//   hold  → voice recording; release stops. Transcribed text appends to
//           the composer; voice commands ("clear", "newline", …) act on
//           the draft.

import { createTerm, type Term } from "./terminal";
import { connect, type Transport } from "./ws";
import { createVoice, type VoiceEvent, type VoiceCommand } from "./voice";
import { keyToBytes } from "./keys";
import { StreamParser } from "./parser";
import { BlockTranscript } from "./blocks";
import { haptic } from "./haptics";

const enc = new TextEncoder();

// --- DOM refs -----------------------------------------------------------

const transcriptEl = document.getElementById("transcript") as HTMLElement;
const xtermHost = document.getElementById("xterm-host") as HTMLElement;
const composer = document.getElementById("composer") as HTMLTextAreaElement;
const composerPane = document.getElementById("composer-pane") as HTMLElement;
const interimLine = document.getElementById("interim-line") as HTMLElement;
const tray = document.getElementById("tray") as HTMLElement;
const overflow = document.getElementById("overflow") as HTMLElement;
const moreBtn = document.getElementById("more-toggle") as HTMLButtonElement;
const joystick = document.getElementById("joystick") as HTMLElement;
const joystickKnob = document.getElementById("joystick-knob") as HTMLElement;
const leaveBtn = document.getElementById("leave") as HTMLButtonElement;
const viewToggle = document.getElementById("view-toggle") as HTMLButtonElement;
const statusOverlay = document.getElementById("status-overlay") as HTMLElement;
const reconnectBtn = document.getElementById("reconnect") as HTMLButtonElement;
const scrollBottomBtn = document.getElementById("scroll-bottom") as HTMLButtonElement;

// --- core wiring --------------------------------------------------------

const transcript = new BlockTranscript(transcriptEl);
const xterm: Term = createTerm();
const parser = new StreamParser();
const ws: Transport = connect();

let hostCols = 80;
let hostRows = 24;

type ViewMode = "block" | "raw";
// viewMode is what's *currently* on screen. userPreference is what the
// user last chose explicitly via the toggle — TUI auto-flips force raw
// regardless, but on the way out we restore the preference instead of
// always landing back in block. Default is raw: it covers Claude/Codex
// out of the box and the block transcript is opt-in.
let viewMode: ViewMode = "block"; // placeholder; real init below
let userPreference: ViewMode = "raw";
let xtermAttached = false;
// Tracks whether we currently hold a geometry override on the server,
// so we know to release it on view-mode change or reconnect.
let overrideActive = false;

function ensureXtermAttached() {
  if (xtermAttached) return;
  xterm.attach(xtermHost);
  xtermAttached = true;
}

// Compute the (cols, rows) that fits the mobile terminal viewport at a
// comfortable fontSize. Used when entering raw mode so the host's PTY
// reflows to a size the phone can actually read.
function preferredRawGeometry(): { cols: number; rows: number } {
  const view = document.getElementById("view") as HTMLElement;
  const rect = view.getBoundingClientRect();
  const FONT = 14;
  const CELL_W = FONT * 0.6;
  const CELL_H = FONT * 1.15;
  // Reserve a bit of padding so cells aren't flush against the edge.
  const padding = 12;
  const cols = Math.max(40, Math.min(160, Math.floor((rect.width - padding) / CELL_W)));
  const rows = Math.max(10, Math.min(80, Math.floor((rect.height - padding) / CELL_H)));
  return { cols, rows };
}

function requestOverride() {
  const { cols, rows } = preferredRawGeometry();
  ws.control({ type: "override-geometry", cols, rows });
  overrideActive = true;
}

function releaseOverride() {
  if (!overrideActive) return;
  ws.control({ type: "release-geometry" });
  overrideActive = false;
}

function setViewMode(m: ViewMode) {
  if (m === viewMode) return;
  viewMode = m;
  transcriptEl.hidden = m !== "block";
  xtermHost.hidden = m !== "raw";
  if (m === "raw") {
    ensureXtermAttached();
    // Ask the server to reflow the PTY for the phone. The geometry
    // event that comes back will trigger xterm.setGeometry.
    requestOverride();
  } else {
    releaseOverride();
  }
  viewToggle.textContent = m === "block" ? "raw" : "blocks";
  viewToggle.setAttribute("data-active", m === "raw" ? "raw" : "block");
  refreshScrollBottom();
}

const sendBytes = (s: string) => ws.send(enc.encode(s));

ws.onOutput((chunk) => {
  ensureXtermAttached();
  parser.feed(chunk, (ev) => {
    if (ev.type === "alt-screen") {
      // Alt-screen on always forces raw. Off restores user preference,
      // so a user who explicitly chose block doesn't get stuck in raw
      // after vim exits — and a user on the default (raw) stays raw.
      setViewMode(ev.on ? "raw" : userPreference);
      return;
    }
    if (ev.type === "cursor") {
      // Hide-cursor forces raw (Claude/Codex/Ink inline TUIs). Show-
      // cursor isn't reliable as an exit signal; command-end handles it.
      if (!ev.visible && viewMode === "block") setViewMode("raw");
      return;
    }
    if (ev.type === "command-end") {
      // If a TUI forced us into raw mid-block, restore the user's
      // preferred view. Otherwise leave it alone.
      if (viewMode === "raw") setViewMode(userPreference);
      transcript.handle(ev);
      return;
    }
    if (ev.type === "bytes") {
      xterm.write(ev.data);
      if (viewMode === "block") transcript.handle(ev);
      return;
    }
    transcript.handle(ev);
  });
  // New content may have shifted us further from the bottom; recompute
  // the FAB after each chunk.
  refreshScrollBottom();
});

xterm.onData((d) => {
  if (viewMode === "raw") sendBytes(d);
});

// --- visual viewport / geometry ----------------------------------------

const rootStyle = document.documentElement.style;
const syncViewport = () => {
  const vv = window.visualViewport;
  if (vv) {
    rootStyle.setProperty("--vv-top", `${vv.offsetTop}px`);
    rootStyle.setProperty("--vv-h", `${vv.height}px`);
  } else {
    rootStyle.setProperty("--vv-top", `0px`);
    rootStyle.setProperty("--vv-h", `${window.innerHeight}px`);
  }
};
const applyLayout = () => {
  syncViewport();
  if (viewMode === "raw") {
    // Viewport reshape (rotation, keyboard, split-view): re-issue the
    // override so the PTY tracks the new size; xterm refits via the
    // resulting geometry event.
    requestAnimationFrame(() => {
      if (overrideActive) requestOverride();
      xterm.setGeometry(hostCols, hostRows);
    });
  }
};
ws.onControl((msg) => {
  if (msg.type === "geometry") {
    hostCols = msg.cols;
    hostRows = msg.rows;
    if (viewMode === "raw") requestAnimationFrame(() => xterm.setGeometry(hostCols, hostRows));
  }
});
syncViewport();
window.addEventListener("resize", applyLayout);
window.addEventListener("orientationchange", applyLayout);
window.visualViewport?.addEventListener("resize", applyLayout);
window.visualViewport?.addEventListener("scroll", applyLayout);

// --- connection status -------------------------------------------------

let userDisconnected = false;
ws.onStatus((s) => {
  document.title = s === "open" ? "baf" : `baf (${s})`;
  if (s === "open") {
    userDisconnected = false;
    statusOverlay.hidden = true;
    // The very first override request (sent from the boot setViewMode)
    // may have been dropped if the WS wasn't open yet. Re-issue here
    // so the PTY is pinned to the phone's size from the moment we have
    // a live connection. Also covers reconnect.
    if (viewMode === "raw") requestOverride();
  } else if (s === "closed" || s === "error") {
    showDisconnected();
  }
});
function showDisconnected() {
  const title = document.getElementById("status-title")!;
  const hint = document.getElementById("status-hint")!;
  title.textContent = "Disconnected";
  hint.textContent = userDisconnected
    ? "The baf session is still running on your computer. Tap to come back."
    : "The connection dropped. Tap to retry.";
  statusOverlay.hidden = false;
}
reconnectBtn.addEventListener("click", () => { userDisconnected = false; ws.reconnect(); });
leaveBtn.addEventListener("click", () => { userDisconnected = true; ws.disconnect(); });
viewToggle.addEventListener("click", () => {
  userPreference = viewMode === "block" ? "raw" : "block";
  setViewMode(userPreference);
});

// --- composer (draft buffer) ------------------------------------------

const HISTORY_KEY = "baf.history";
const history: string[] = readHistory();
let historyCursor = history.length;

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch { return []; }
}
function writeHistory() {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-500))); }
  catch { /* quota; ignore */ }
}
function autosizeComposer() {
  composer.style.height = "auto";
  composer.style.height = Math.min(composer.scrollHeight, 200) + "px";
}
composer.addEventListener("input", autosizeComposer);

function getDraft(): string { return composer.value; }
function setDraft(s: string) { composer.value = s; autosizeComposer(); }
function appendDraft(s: string) {
  const cur = composer.value;
  if (!cur) composer.value = s;
  else if (/\s$/.test(cur) || /^[ \t.,;:!?)\]}\n]/.test(s)) composer.value = cur + s;
  else composer.value = cur + " " + s;
  autosizeComposer();
}
function clearDraft() { composer.value = ""; setInterim(""); autosizeComposer(); }
function commitDraft() {
  const text = composer.value;
  if (text) {
    history.push(text);
    historyCursor = history.length;
    writeHistory();
    transcript.noteSentCommand(text);
    sendBytes(text);
  }
  sendBytes("\r");
  composer.value = "";
  setInterim("");
  autosizeComposer();
}

composer.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    commitDraft();
    return;
  }
  if (ev.key === "ArrowUp" && history.length > 0
      && composer.selectionStart === 0 && composer.selectionEnd === 0) {
    ev.preventDefault();
    historyStep(-1);
  } else if (ev.key === "ArrowDown" && historyCursor < history.length
      && composer.selectionStart === composer.value.length) {
    ev.preventDefault();
    historyStep(1);
  }
});

function historyStep(dir: -1 | 1) {
  if (history.length === 0) return;
  historyCursor = Math.max(0, Math.min(history.length, historyCursor + dir));
  composer.value = historyCursor === history.length ? "" : history[historyCursor];
  autosizeComposer();
  composer.setSelectionRange(composer.value.length, composer.value.length);
}

// --- voice (driven by joystick hold) -----------------------------------

const voice = createVoice();
function setInterim(s: string) { interimLine.textContent = s; }
function setComposerRecording(on: boolean) {
  composerPane.setAttribute("data-recording", String(on));
}
voice?.on((ev: VoiceEvent) => {
  switch (ev.kind) {
    case "interim":  setInterim(ev.text); break;
    case "final":    setInterim(""); appendDraft(ev.text); break;
    case "key":      pressKey(ev.name); break;
    case "command":  handleVoiceCommand(ev.cmd); break;
  }
});
function handleVoiceCommand(cmd: VoiceCommand) {
  switch (cmd) {
    case "execute":         commitDraft(); break;
    case "clear":           clearDraft(); break;
    case "newline":         appendDraft("\n"); break;
    case "backspace-word":  setDraft(getDraft().replace(/\s+\S*\s*$/, "")); break;
  }
}

// --- tray + overflow ---------------------------------------------------

const pressKey = (name: string) => {
  const bytes = keyToBytes(name);
  if (bytes) sendBytes(bytes);
};
tray.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn) return;
  const key = btn.dataset.key;
  if (!key) return;
  if (key === "more") { toggleOverflow(); return; }
  pressKey(key);
});
overflow.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest("button");
  if (!btn) return;
  const key = btn.dataset.key;
  if (!key) return;
  pressKey(key);
  closeOverflow();
});
function toggleOverflow() { overflow.hidden ? openOverflow() : closeOverflow(); }
function openOverflow()  { overflow.hidden = false; moreBtn.setAttribute("aria-expanded", "true"); }
function closeOverflow() { overflow.hidden = true;  moreBtn.setAttribute("aria-expanded", "false"); }
document.addEventListener("click", (ev) => {
  if (overflow.hidden) return;
  const t = ev.target as Node;
  if (overflow.contains(t) || moreBtn.contains(t)) return;
  closeOverflow();
});

// --- joystick gesture state machine -----------------------------------

type Gesture = "idle" | "pressed" | "dragging" | "holding";
type Dir = "up" | "down" | "left" | "right";

let gesture: Gesture = "idle";
let gesturePointerId = -1;
let gestureStartX = 0;
let gestureStartY = 0;
let gestureDir: Dir | null = null;
let holdTimer: number | null = null;
let repeatTimer: number | null = null;

const HOLD_MS = 280;             // press → voice
const MOVE_THRESHOLD = 14;       // px before we count as dragging
const KNOB_MAX_OFFSET = 18;      // visual cap on knob translation
const REPEAT_INITIAL_DELAY = 380;
const REPEAT_INTERVAL = 90;

function setGesture(g: Gesture) {
  gesture = g;
  joystick.setAttribute("data-state", g);
}

function setKnobOffset(dx: number, dy: number) {
  const len = Math.hypot(dx, dy);
  if (len > KNOB_MAX_OFFSET) {
    const k = KNOB_MAX_OFFSET / len;
    dx *= k; dy *= k;
  }
  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
}

function setArrowActive(dir: Dir | null) {
  for (const d of ["up", "down", "left", "right"] as const) {
    const el = joystick.querySelector(`.joystick-arrow.${d}`) as HTMLElement | null;
    if (el) el.setAttribute("data-active", String(d === dir));
  }
}

function dominantDir(dx: number, dy: number): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

// In raw mode every direction goes to the PTY. In block mode ↑/↓ scrub
// history (the shell isn't echoing keys back, so arrow keys would be
// invisible). Left/right have no block-mode meaning and are ignored.
function fireDir(dir: Dir) {
  if (viewMode === "raw") {
    pressKey(dir);
    return;
  }
  if (dir === "up") historyStep(-1);
  else if (dir === "down") historyStep(1);
}

function cancelTimers() {
  if (holdTimer !== null) { clearTimeout(holdTimer); holdTimer = null; }
  if (repeatTimer !== null) { clearTimeout(repeatTimer); repeatTimer = null; }
}

function startRepeat(dir: Dir) {
  cancelTimers();
  const tick = () => {
    if (gesture !== "dragging" || gestureDir !== dir) return;
    fireDir(dir);
    repeatTimer = window.setTimeout(tick, REPEAT_INTERVAL);
  };
  repeatTimer = window.setTimeout(tick, REPEAT_INITIAL_DELAY);
}

joystick.addEventListener("pointerdown", (e: PointerEvent) => {
  e.preventDefault();
  if (gesture !== "idle") return;
  joystick.setPointerCapture(e.pointerId);
  gesturePointerId = e.pointerId;
  gestureStartX = e.clientX;
  gestureStartY = e.clientY;
  setGesture("pressed");
  haptic.light();
  holdTimer = window.setTimeout(() => {
    if (gesture !== "pressed") return;
    if (!voice) return; // no support; tap-on-release still submits
    setGesture("holding");
    setComposerRecording(true);
    haptic.heavy();
    voice.toggle();
  }, HOLD_MS);
});

joystick.addEventListener("pointermove", (e: PointerEvent) => {
  if (e.pointerId !== gesturePointerId) return;
  if (gesture === "holding" || gesture === "idle") return;
  const dx = e.clientX - gestureStartX;
  const dy = e.clientY - gestureStartY;
  if (gesture === "pressed") {
    if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
    cancelTimers();        // voice timer aborts
    setGesture("dragging");
    haptic.medium();
  }
  if (gesture === "dragging") {
    setKnobOffset(dx, dy);
    const dir = dominantDir(dx, dy);
    if (dir !== gestureDir) {
      gestureDir = dir;
      setArrowActive(dir);
      haptic.selection();   // each new direction; not on repeat
      fireDir(dir);
      startRepeat(dir);
    }
  }
});

function endGesture() {
  const prev = gesture;
  cancelTimers();
  setKnobOffset(0, 0);
  setArrowActive(null);
  if (prev === "pressed") {
    haptic.medium();
    commitDraft();
  } else if (prev === "holding") {
    haptic.light();
    if (voice?.isActive()) voice.toggle();
    setComposerRecording(false);
    setInterim("");
  }
  gestureDir = null;
  gesturePointerId = -1;
  setGesture("idle");
}

joystick.addEventListener("pointerup",     (e: PointerEvent) => { if (e.pointerId === gesturePointerId) endGesture(); });
joystick.addEventListener("pointercancel", (e: PointerEvent) => { if (e.pointerId === gesturePointerId) endGesture(); });

// Keyboard a11y: Space/Enter on the focused joystick submits.
joystick.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" || ev.key === " ") {
    ev.preventDefault();
    commitDraft();
  }
});

// --- scroll-to-latest FAB ---------------------------------------------

// The FAB shows whenever the visible area in either view isn't at the
// bottom. We poll on (a) user scroll events on either container,
// (b) every chunk of PTY output (block mode appends; xterm's onScroll
// also fires on content writes that scroll its buffer), and (c) view
// mode changes.
function isAtBottom(): boolean {
  if (viewMode === "block") {
    const t = transcriptEl;
    return t.scrollHeight - t.scrollTop - t.clientHeight < 24;
  }
  // xterm: viewportY === baseY means the user is at the live bottom.
  const buf = xterm.term.buffer?.active;
  if (!buf) return true;
  return buf.viewportY >= buf.baseY;
}

function refreshScrollBottom(): void {
  scrollBottomBtn.setAttribute("data-visible", String(!isAtBottom()));
}

transcriptEl.addEventListener("scroll", refreshScrollBottom, { passive: true });
xterm.term.onScroll(() => refreshScrollBottom());

scrollBottomBtn.addEventListener("click", () => {
  if (viewMode === "block") {
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: "smooth" });
  } else {
    xterm.term.scrollToBottom();
  }
  // Optimistically hide; the resulting scroll event will confirm.
  scrollBottomBtn.setAttribute("data-visible", "false");
});

// --- boot --------------------------------------------------------------

autosizeComposer();
// Apply the default view mode. viewMode starts as "block" so this call
// actually runs the block → raw transition (attaches xterm, requests
// override). If the WS isn't open yet the override request is replayed
// by the open-status handler.
setViewMode(userPreference);
refreshScrollBottom();
