# Back and Forth (BAF)

This application is a simple back and forth between terminal on pc and a mobile device. Specifically it:

1. Creates a mirrored terminal session between the PC and Mobile Device
2. Accessed through a web interface on mobile, allowing users to control a specific terminal session from their mobile device on the same local network.
3. Using it is as simple as calling baf, and the existing terminal session's buffer is then mirrored on the mobile device.
   a. there is then a simple token based auth flow that can be scanned and logged in via a QR code.
4. The mobile web apps user interface is design to simplify on mobile. i.e.
   a. Touch-friendly controls, scrolling
   b. Simplified navigation and layout (buttons for control-c, escape, etc.)
   c. An escape hatch for people that use this repo to add more buttons in an action tray.
   d. Responsive design that adapts to different screen sizes and orientations.
   e. A voice based entry input system that allows users to input text and commands using their voice, but optimized for what is a developer and typical terminal workflow / usage scenario.
   f. The UI should feel native to terminal, not making it feel really disconnected from typcial astheic

## Non-goals

- We don't want to create support out of network, but rather focus on a local network solution; for now.

# Instructions

- Use this document as a log of the development process and decisions made; it will help track the evolution of the project and the rationale behind each decision.
- Use first principles approach, starting with thinking through the fundmental technologies to use vs. just adding features on top of the existing stack.
- Focus on the core functionality and user experience, rather than trying to implement every possible feature at once.
- Make the README file instructinos for a human or agent to understand and use the application.
- I care a lot about the user expeiriences asthetics, minimalism, and elegance.

# Decision Log

Append-only. Each entry: date, decision, reasoning, alternatives considered.

## 2026-05-10 — PTY-spawn model (not parent-TTY attach)

`baf` spawns the user's `$SHELL` inside a PTY it owns and mirrors that PTY. The mental model stays "call baf and your session is mirrored," but mechanically the mirrored session begins *from the moment baf is invoked* — not retroactively.

**Why:** There is no portable way to attach to a parent process's TTY after the fact. Every comparable tool (ttyd, gotty, tmate, asciinema) resolves this the same way.

**Alternatives considered:** Hooking tmux control mode would allow true attach to a pre-existing session, but it makes tmux a hard dependency and breaks the "as simple as calling baf" bar. Revisit if it ever becomes the blocking ergonomic.

## 2026-05-10 — Go for the CLI runtime

**Why:** Single static binary, trivial install (`brew install` / `go install`), no runtime to install on the user's machine. First-class PTY (`creack/pty`), HTTP, and WebSocket support. The frontend is embedded into the binary via `go:embed` so distribution is one file.

**Alternatives considered:** Node + `node-pty` (sharper distribution edges, requires Node on the user's machine or a packager). Bun + TypeScript (single language across server/client, `bun build --compile` produces a binary, but PTY handling has rougher edges).

## 2026-05-10 — Single mobile client at a time

The local terminal is always the primary writer. At most one mobile client may connect and write at a time; additional connection attempts are refused with a clear error. The local terminal cannot be locked out.

**Why:** Simpler auth, no write-conflict UX, no surprise spectators on the same LAN. Matches the minimalism brief.

**Alternatives considered:** Multi-viewer + one-writer-lock for pair programming / demos. Defer; can be added without protocol changes by introducing a writer-lock handoff message.

## 2026-05-10 — Self-signed HTTPS, generated on first run

`baf` generates a self-signed certificate on first run, caches it under `~/.baf/`, and serves the UI over HTTPS bound to the LAN IP.

**Why:** The Web Speech API (voice input) only works on HTTPS or `localhost`. We need voice on mobile, so we need HTTPS. The browser warns once on first connection, then trusts the cached cert.

**Alternatives considered:** Plain HTTP and drop voice for v1 — would have been simpler distribution but loses a feature explicitly called for in the brief.

## 2026-05-10 — Quitting: `baf-quit` shim + SIGTERM, mobile "disconnect" closes WS

Two ways out:

- **Desktop:** on launch, `baf` writes a `baf-quit` shell script to a
  tempdir and prepends that dir to the spawned shell's `PATH`. The script
  does `kill -TERM $BAF_PID`. `baf` traps SIGTERM/SIGHUP, closes the PTY
  (which SIGHUPs the inner shell), shuts down the server, restores the
  local terminal, and exits. `exit` / Ctrl-D in the shell still works via
  the normal "shell exited" path.
- **Mobile:** a `disconnect` button in the overflow menu calls
  `WebSocket.close(1000)`. The server releases the writer lock so a fresh
  connection (this device or another) can be admitted. A "Disconnected"
  overlay appears with a Reconnect button; unexpected drops surface the
  same overlay with a different hint.

**Why:** `exit` and Ctrl-D weren't discoverable — the user asked twice how
to leave. Putting the affordance on the banner ("quit: baf-quit, exit, or
Ctrl-D") and giving the mobile UI an explicit disconnect closes the gap
without adding stateful machinery.

**Alternatives considered:** A magic keychord (Ctrl-\ Ctrl-X, screen-style)
would have avoided touching PATH but isn't discoverable. Writing a shell
alias into the user's rc would be more durable across sub-shells but is
too invasive for a tool that should be ephemeral.

**Caveat:** If the user's rc replaces `PATH` outright (rare for login
shells), the `baf-quit` shim falls off the path. `BAF_PID` is also
exported so `kill -TERM $BAF_PID` still works as a fallback.

## 2026-05-11 — Host owns PTY geometry; mobile is a viewer that font-fits

A PTY has one set of (cols, rows). The previous design let the mobile
client push its viewport size as a `resize` control message, which
*shrunk the PTY to phone dimensions*. The host's terminal kept its
window size but rendered narrow content — looked "thin", and any
scrollback emitted at the old wider geometry collided visually with
new narrow output. Symptom: terminals appearing to overwrite each
other's buffers.

New model:

- **The host's SIGWINCH is the only thing that resizes the PTY.**
- On WS open and on every host resize, the server pushes a
  `{"type":"geometry","cols":N,"rows":M}` text frame to the mobile.
- The mobile renderer calls `term.resize(cols, rows)` and picks the
  largest `fontSize` (clamped 8–18) that lets cols×rows fit its current
  visual viewport. Going landscape recomputes; the keyboard rising
  recomputes; the PTY never moves.
- If the host is very wide and the phone is small, fontSize clamps to
  the minimum and the terminal container scrolls horizontally.

**Why:** The host is where the work *happens*; the phone is a viewer
and control surface. Making the host's terminal feel native is
non-negotiable. Mobile rendering is free to adapt — that's what
renderers are for.

**Alternatives considered:** `min(local, mobile)` per dimension — both
terminals would render correctly but the host's terminal would appear
underused (whitespace) whenever the phone connected. Rejected for the
same "feel native" reason.

**Wire-protocol change:** The client's outbound `resize` control
message is removed. The server now sends `geometry` (inbound from the
client's perspective). Ping is still the only outbound text frame.

## 2026-05-11 — Mobile UI: terminal is read-only; bottom panel owns interaction

The terminal area no longer summons the soft keyboard on tap. xterm's
internal helper textarea is disabled via `pointer-events: none`, and we
never call `term.focus()` ourselves on mobile. The terminal is now
purely a viewer that the user can scroll/inspect without the layout
constantly reflowing around an in-and-out keyboard.

All interaction moves to a persistent bottom panel with two modes
selected via a tab strip:

- **type** — visible prompt bar (`›` glyph + transparent input). Tapping
  the bar focuses the input; each keystroke goes live to the PTY exactly
  like before (sentinel ZWSP + `beforeinput` rewrites). The input is
  styled so its actual contents are invisible — the user sees their
  typing as terminal echo above, not as accumulated bar content.
- **voice** — the keyboard is dismissed; a 72px circular record button
  toggles recognition; interim transcripts show as a dim line; final
  segments populate an editable contenteditable draft below. The user
  taps the draft to revise, then taps "↩ send" (or speaks "submit") to
  push it to the PTY with a trailing `\r`. Voice command phrases still
  fire (`execute`, `clear`, `newline`, `backspace-word`) and named keys
  (`ctrl-c`, `esc`, arrows) still bypass the draft.

A small `leave` chip in the mode bar handles disconnect (replaces the
overflow-menu disconnect).

**Why:** The keyboard animating up and down was the primary source of
scroll jitter — every tap on the terminal triggered a viewport resize
which reflowed the bottom-anchored grid. Making the terminal
non-interactive (on mobile) and giving the user an explicit mode switch
costs ~80px of permanent panel height in exchange for a stable terminal
that scrolls smoothly.

**Type / voice as tabs (not toggle):** mode is a deliberate user choice.
Tapping `voice` blurs the keyboard up-front, so the record button isn't
fighting an animation. Tapping `type` stops any active recording and
re-focuses the prompt bar.

## 2026-05-11 — Mobile is a block transcript, not a terminal emulator

Rebuilt the mobile UI around the insight that "full PTY emulator on a
phone" is the wrong primitive. Mobile is now a Warp/Jupyter-style
transcript: each command is a block with timestamp, exit code,
duration, and styled output. xterm.js is still there but only mounts
when something takes over the screen (vim, htop, less). The
escape-hatch is automatic; users don't pick a mode.

**Block boundaries: OSC 133 shell integration.** baf launches the
user's shell pointed at a generated rc (ZDOTDIR for zsh, --rcfile for
bash). The shim sources the user's real rc then registers
precmd/preexec hooks that emit:

  - OSC 133;A — prompt about to render
  - OSC 133;C — command starts running (bash uses PS0)
  - OSC 133;D;<exit> — command finished

The user's home dotfiles are untouched. These sequences are silently
consumed by every modern terminal, so the host's view is unaffected.
Shells we don't recognize get a plain login launch and the mobile UI
defaults to a single anonymous block streaming bytes — degraded but
not broken.

**Auto raw mode on alt-screen.** Programs that take over the screen
emit CSI ?1049h (or ?47h / ?1047h). The client parser watches for
these and flips between transcript and xterm.js. The matching ?l
sequence flips back. vim/htop/fzf/less/lazygit all use the alt-screen
and therefore work without any explicit toggle.

**Wire protocol unchanged.** All parsing is client-side: the server
still streams raw PTY bytes over the WebSocket. This means the desktop
mirror keeps working byte-perfect, and adding more shell-integration
markers later (cwd reporting, command attribution, …) requires no
protocol changes.

**Composer instead of live keystrokes.** The bottom panel has a
visible textarea. The user types or pulls from history (↑/↓ buttons
in the tray; physical arrow keys when a keyboard is attached) and
taps send. We push `command + \r`. No surprise keyboard pops, no
viewport thrash. Voice mode is unchanged — same draft/edit/submit
flow, now feeding the same composer pipeline.

**What we accepted:**
- progress bars rendered with `\r` are handled, but more exotic
  cursor-position TUIs that don't use alt-screen render imperfectly.
- shells other than zsh and bash get the no-injection degraded path.
- the first prompt's `D;0` is benign noise (precmd fires before the
  first prompt) — the block UI just doesn't render an empty block.

## 2026-05-10 — Stack summary

- **Backend:** Go, `creack/pty`, `coder/websocket`, `mdp/qrterminal/v3`, stdlib `crypto/tls` for cert generation.
- **Frontend:** TypeScript + Vite + xterm.js, no UI framework. Hidden input overlay for mobile keyboard. Web Speech API for voice with a developer-vocabulary remapping layer (e.g., "control C" → `\x03`).
- **Wire protocol:** WebSocket. Binary frames = raw PTY bytes both directions. Text frames = JSON control (`resize`, `ping`).
- **Auth:** One-time token in URL (printed + QR-encoded by `baf`). Token validates once on first hit, server issues a session cookie, WS upgrade is cookie-gated.
- **Scrollback on connect:** ~256KB ring buffer of recent PTY output, replayed to new clients before live stream begins. xterm.js owns scrollback from there.
