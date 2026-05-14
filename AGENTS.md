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

## 2026-05-11 — Joystick + composer replace type/voice tabs

The earlier "type / voice as tabs" and "↑/↓ history buttons in the
tray" designs are superseded by a single unified input surface:

- A **composer** textarea holds the draft. Enter submits.
- A **joystick** to the right of the composer carries three gestures:
  - **tap** — commit the draft (`text + \r`).
  - **drag** — arrow key in the dominant direction, auto-repeating
    while held. In block view, ↑/↓ scrub composer history (the shell
    isn't echoing keys, so PTY-arrow scrubbing wouldn't be visible);
    in raw view all four arrows go to the PTY.
  - **hold** — start voice recording; release stops. Transcripts
    append to the composer so the user can edit before sending. Voice
    commands ("clear", "newline", …) act on the draft, not the PTY.
- The **mode bar** carries a `raw` / `block` view toggle and a
  `leave` button. The overflow that used to hold `disconnect` now
  holds extra control keys (`Ctrl-D`, `Ctrl-L`, `Ctrl-Z`, …) reached
  via the `…` button in the tray.

**Why:** Tabs forced an explicit mode choice for what should be one
continuous flow — start typing, hold to dictate, drag to arrow, tap
to send. A single gesture surface removes the mode switch entirely
and frees the bottom panel for one tray of keys instead of two
visual states. The `leave` button moves into the mode bar because
disconnecting is a session-level action, not a key.

**Alternatives considered:** Keep separate record button + history
buttons. Rejected: the joystick already has a natural press affordance
and a natural directional affordance, and reusing it kept the panel
small enough to leave the transcript readable on a phone.

## 2026-05-11 — Raw view negotiates its own PTY geometry

Earlier rule: "The host's SIGWINCH is the only thing that resizes the
PTY." Still true *by default*, but the mobile client may now request a
phone-friendly geometry while it's in raw view, since alt-screen TUIs
(vim, fzf, Claude/Codex) are unreadable at 200-column host geometry on
a phone.

Two new control messages:

- `{"type":"override-geometry","cols":N,"rows":M}` — the client asks
  the server to resize the PTY to a geometry it computed from its
  viewport.
- `{"type":"release-geometry"}` — the client gives the override back;
  the server restores the host's geometry.

The server applies the override only while a client is actively holding
it; switching back to block view, disconnecting, or reconnecting
releases it. The host's SIGWINCH is still authoritative whenever no
override is active.

**Why:** Raw view is the escape hatch for full-screen TUIs, and those
TUIs only render correctly if the PTY itself is the size of the phone's
visible area. The host accepts a temporary squeeze for the duration of
that mode, in exchange for the phone being usable for `vim`, `fzf`,
`htop`, Claude Code, etc.

**Alternatives considered:** Render the host-sized PTY into an
xterm.js viewport that horizontally scrolls. Rejected: TUIs use
absolute cursor positioning, so scrolling the viewport doesn't help —
the user still can't see where the cursor is.

## 2026-05-11 — `BAF_DEV` reverse-proxies the UI to Vite for HMR

The frontend is embedded into the Go binary via `go:embed`, so a plain
refresh of a running `baf` does not pick up UI edits — every change
requires a full rebuild. That's right for distribution but punishing for
UI iteration.

New: if `BAF_DEV` is set to a URL (e.g. `http://localhost:5173`), the
server's static handler is replaced by an `httputil.ReverseProxy` to
that target. `make dev` boots Vite first, waits for it to answer, then
runs `baf` with `BAF_DEV` pointing at it. The phone connects to baf as
usual (HTTPS, token, cookie); the UI is served from Vite and hot-reloads
on edit.

**Why this shape, not others:**

- *Why proxy instead of serving Vite directly to the phone?* The Web
  Speech API requires HTTPS. Vite's dev server is plain HTTP. Putting
  Go's HTTPS listener in front keeps voice working in dev.
- *Why not Vite's own HTTPS mode?* That would mean two self-signed
  certs the phone has to trust, and the cookie auth flow would have to
  be reimplemented in front of Vite. Proxying is a single chokepoint.
- *Why `httputil.ReverseProxy` and not a hand-rolled handler?* Modern
  Go's reverse proxy transparently handles WebSocket upgrades, which
  is what makes Vite HMR work end-to-end through our HTTPS listener
  without any extra plumbing. `/api/ws` is mounted before the static
  handler so the PTY WS is unaffected.

**Caveats accepted:**

- A `baf` restart rotates the session cookie, so the phone has to
  re-scan the QR after each Go restart. UI-only edits don't require a
  restart and so don't trigger this.
- The dev proxy honors the same auth as the embedded path — there is
  no "skip auth in dev" footgun.

## 2026-05-11 — Frontend rebuilt on React (composable layout + handlers)

Replaced the imperative `main.ts` boot with a React component tree.
Same DOM IDs, same CSS, same wire protocol, same Go backend.

- Pure session reducer (`session.ts`) owns composer draft, history,
  recording indicator, view mode, user preference. Side-effectful
  actions (commit → send PTY bytes + persist history) are bound in the
  `useSession()` hook.
- Pure blocks reducer (`blocks.ts`) owns the transcript: block list,
  pending command, prompt/output state. A separate side-effect
  controller (`makeBlockController`) maps PTY parser events into
  reducer actions and owns the per-block AnsiRenderer instance.
- ANSI rewritten as a pure stream → `Line[]` of `{id, segments}`
  records (`ansi.ts`). `<Block/>` renders segments as styled spans.
  No DOM mutation outside React's reconciliation.
- xterm.js wrapped in `<RawTerminal/>` with the geometry-override
  lifecycle (request on raw-mode entry / status open / viewport
  reshape; release on exit) managed by `useEffect`.
- Joystick gesture state machine in `useJoystick`; hooked to session
  actions (tap → commit, drag → arrows/history, hold → voice).
- Voice events flow through `useVoice` into the same session actions.

**Why:** It became hard to reason about what owned which DOM mutation
when adding behavior. The block-rendering hot path was already 300
lines of imperative DOM building (`AnsiRenderer`) — moving that to
declarative spans and putting view/composer state behind a reducer
turns "where do I add this handler/layout?" into "which component or
hook owns this concern?"

**What stays byte-for-byte:** wire protocol, OSC 133 parser
(`parser.ts`), `voice.ts`, `keys.ts`, `haptics.ts`, the Go server,
all CSS (all IDs preserved so styles needed no edits).

**Cost:** +45KB gz for React. Acceptable next to xterm.js's ~200KB
already in the bundle.

**Alternatives considered:** Preact (smaller, drop-in JSX) and Solid
(signals fit our reducer shape). Both viable; React picked because it
hits zero adoption friction for contributors and the bundle delta is
small relative to what we're already shipping.

## 2026-05-11 — Block transcript removed; raw is the only view

Earlier we kept two renderers side-by-side: a Warp-style block
transcript driven by OSC 133 markers, and xterm.js for alt-screen
TUIs, with auto-flip between them. Block mode is now removed —
xterm.js is the only renderer.

What goes away with it: `<BlockTranscript>`, the `BlocksState`
reducer + `BlockController` side-effect controller, the per-block
`AnsiRenderer`, the `history-blocks` builder, `viewMode` /
`userPreference` in session state, the alt-screen / cursor-visibility
mode flips, the view toggle in the overflow menu, and the block-mode
branch of the joystick directionals (↑/↓ as composer history scrub) —
the joystick always drives the PTY now.

What stays: the OSC 133 shell-integration injection on the server
(harmless; consumed silently by xterm) and the `history-start` /
`history-end` control frames on the wire — the client now drops the
history bytes since xterm's scrollback appends and the server sends
the tail first, which would put older content beneath newer content
if both were written.

**Why:** Two renderers in parallel was paying for itself only when a
shell-integrated command finished cleanly inside a non-alt-screen
session, and most of the time the user was either looking at xterm
already (Claude/Codex/vim/fzf) or wanted a single source of truth
for what their terminal looks like. Carrying the block path forward
also meant every wire-format or input refactor had to be tested
against both views. Removing it is ~600 lines lighter and collapses
the state machine.

**Cost accepted:** the visual command-by-command transcript with
exit codes and durations is gone. Older scrollback beyond xterm's
internal buffer (`scrollback: 1000`) is no longer browsable from the
phone — the replayed history bytes are dropped on arrival.

## 2026-05-13 — Distribution via Homebrew tap (GoReleaser-driven)

A one-time `brew tap rthomare/baf` followed by `brew install baf` is
the supported install path. After the tap is registered the install
command is unqualified — Homebrew's resolver searches tapped repos
for an exact-name match when no homebrew-core formula exists. License
is Apache-2.0 (LICENSE file at repo root). Mechanics:

- `.goreleaser.yaml` cross-compiles `baf` for darwin/linux × amd64/arm64
  with `CGO_ENABLED=0`, after a `before:hooks` step that runs
  `npm ci && npm run build` in `web/` so the embedded UI is present.
- `.github/workflows/release.yml` runs on `v*` tags, sets up Go + Node,
  and invokes GoReleaser. The default `GITHUB_TOKEN` publishes the
  archives + checksums to a release on this repo; a separate
  `HOMEBREW_TAP_GITHUB_TOKEN` (PAT scoped to `rthomare/homebrew-baf`)
  pushes the refreshed `Formula/baf.rb` to the tap.
- `main.version` is stamped via `-ldflags -X main.version={{ .Version }}`
  and surfaced by `baf --version` (handled before the run loop so it
  works without an interactive TTY — needed for the brew formula's
  `test do` block).
- Local builds via `make go` stamp `git describe` into the same
  variable so `./baf --version` is meaningful during development.

**Why this shape, not others:**

- *Why a tap and not homebrew-core?* homebrew-core requires the project
  to clear popularity thresholds and gives up the ability to ship
  patches on our own cadence. The tap is the standard pattern for a
  fresh project.
- *Why prebuilt binaries instead of a `go build` formula?* The build
  needs Node to produce the embedded `dist/`. A source-build formula
  would either depend on Node-as-build-dep (slow, network-heavy) or
  ship the prebuilt `dist/` in the git tag (couples release ergonomics
  to the source tree). GoReleaser handles the build once per release
  and brew users just download bytes.
- *Why GoReleaser?* It cross-compiles, archives, checksums, generates
  GitHub releases, and pushes the brew formula in one step. The brew
  formula it emits already includes a `test do` block invoking
  `bin/baf --version`, which is why that flag exists.

**Caveats accepted:**

- A PAT is needed because `GITHUB_TOKEN` is scoped to the running repo
  and can't push to `homebrew-baf`. Documented in `RELEASING.md`.
- Tap users on Linux can install via Homebrew on Linux but the binary
  has only been smoke-tested on macOS so far.
- The unqualified `brew install baf` only works after the user has run
  `brew tap rthomare/baf` once. Submitting the formula to
  `Homebrew/homebrew-core` would make the tap step unnecessary, but
  that's gated on notability (~30 forks / 30 watchers / 75 stars per
  Homebrew's acceptable-formulae rules) which the project doesn't yet
  meet. Revisit when the metrics are there; the formula GoReleaser
  emits today is a reasonable starting point.

## 2026-05-10 — Stack summary

- **Backend:** Go, `creack/pty`, `coder/websocket`, `mdp/qrterminal/v3`, stdlib `crypto/tls` for cert generation.
- **Frontend:** TypeScript + Vite + React 18 + xterm.js. Reducer-managed session state; xterm.js is the sole renderer. Hidden input overlay for mobile keyboard. Web Speech API for voice with a developer-vocabulary remapping layer (e.g., "control C" → `\x03`).
- **Wire protocol:** WebSocket. Binary frames = raw PTY bytes both directions. Text frames = JSON control (`resize`, `ping`).
- **Auth:** One-time token in URL (printed + QR-encoded by `baf`). Token validates once on first hit, server issues a session cookie, WS upgrade is cookie-gated.
- **Scrollback on connect:** ~256KB ring buffer of recent PTY output, replayed to new clients before live stream begins. xterm.js owns scrollback from there.
