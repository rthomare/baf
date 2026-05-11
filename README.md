# baf — back and forth

Mirror the terminal session in front of you onto your phone, over your local
Wi-Fi. Type on your laptop or your phone; both stay in sync.

```
$ baf
┌─ back and forth ─┐
│ open on your phone
│ https://192.168.1.42:8443/?t=…
│ (single-use link — token consumed on first scan)
└──────────────────┘
<QR>
$ █          ← your shell, business as usual, now mirrored
```

## What it does

- Spawns your `$SHELL` inside a PTY that `baf` owns, then tees output to
  both your local terminal and a mobile browser on the same LAN.
- Serves a tiny, terminal-native web UI for the phone: a block transcript
  with an xterm.js fallback for full-screen TUIs, a composer + joystick
  input surface, and voice input tuned for shells.
- Uses HTTPS with a self-signed cert generated on first run. One token-bearing
  link is printed (and QR-encoded). The token is consumed on first scan and
  a session cookie takes over from there.
- Refuses a second mobile client while one is connected. The local terminal
  is always the primary writer.

## What it isn't

- Not a remote-access tool. It binds to a LAN IP and is not meant to traverse
  NAT. If your phone isn't on the same Wi-Fi, it can't reach you.
- Not a fully transparent attach-to-running-shell. The mirrored session
  begins when you run `baf`; everything from that point forward is mirrored.

## Quickstart

Requirements: Go 1.26+, Node 20+ (only for building the UI), a Mac or Linux.

```sh
# clone, then:
make build       # builds web UI + Go binary (./baf)
./baf
```

Open the URL on your phone — accept the one-time TLS warning the first time,
then it's trusted on that device.

## Development

```sh
make dev         # Vite dev server + baf with HMR (recommended for UI work)
make web         # build just the frontend (writes to internal/webfs/dist)
make go          # build just the binary
go test ./...    # run server auth-flow tests
```

The frontend lives in `web/` (Vite + TypeScript + xterm.js). The build output
is written into `internal/webfs/dist/` and embedded into the Go binary via
`go:embed`, so a release is one file.

`make dev` starts Vite on `localhost:5173`, then runs `baf` with
`BAF_DEV=http://localhost:5173`. When `BAF_DEV` is set, the Go server
reverse-proxies the UI (and Vite's HMR WebSocket) to Vite instead of serving
the embedded `dist/`. `/api/ws` and the auth flow are unchanged, so the phone
still connects exactly as in production — it just gets live-reloaded UI.
Restarting `baf` rotates the session cookie, so you'll need to re-scan the
QR after each Go restart; pure UI edits hot-reload without restart.

## Layout

```
cmd/baf/                  entry point: parse env, spawn PTY, start server
internal/pty/             PTY session, ring buffer, single-writer lock
internal/server/          HTTPS + WebSocket + token auth
internal/shellinit/       generated rc shim that emits OSC 133 markers
internal/tlsgen/          self-signed cert generation (~/.baf/)
internal/qr/              terminal QR rendering
internal/webfs/           go:embed of the built UI
web/                      Vite + xterm.js frontend
AGENTS.md                 brief + decision log (read me first)
```

## How the mobile UI works

The phone isn't a terminal emulator; it's a **block transcript** of your
session. Each command becomes a block with a timestamp, exit code, and
streamed output. The host's terminal is untouched and feels native.

`baf` quietly injects [OSC 133 shell integration][osc133] when it
launches your shell. For zsh it sets a temporary `ZDOTDIR`; for bash it
passes `--rcfile`. The shim sources your real rc, then layers OSC 133
markers around each prompt so the mobile parser can tell where commands
start and end. Your home dotfiles are not modified.

When a program takes over the screen (`vim`, `htop`, `less`, `fzf`, …)
it emits the alternate-screen sequence; the mobile client detects that
and seamlessly switches to xterm.js for the duration. When the program
exits, the block transcript comes back. A `raw` / `block` toggle in the
mode bar also lets you force either view at any time; raw mode asks the
host PTY to reflow to a phone-friendly geometry, and releases that
override when you switch back.

Shells other than zsh and bash are launched plainly and the mobile UI
gracefully degrades to a single rolling block — usable, just without
block boundaries.

### Input surface

A single bottom panel handles all input:

- A **composer** textarea holds your draft; tap to edit, Enter sends.
- A **joystick** to the right of the composer does three jobs by gesture:
  - **tap** — submits the draft (`text + \r`).
  - **drag** — arrow key in the dominant direction, auto-repeating while
    held. In block view, ↑/↓ scrub composer history; in raw view all four
    arrows go to the PTY.
  - **hold** — starts voice recording; release stops. Transcripts append
    to the composer so you can edit before sending.
- A thin **tray** above the composer carries `ctrl-c`, `esc`, `tab`, and a
  `…` button that opens an overflow with `Ctrl-D`, `Ctrl-L`, `Ctrl-Z`,
  `Ctrl-R`, `Ctrl-U`, `Ctrl-W`, `Home`, `End`, `PgUp`, `PgDn`.
- The **mode bar** holds the `raw`/`block` toggle and a `leave` button
  that disconnects this device.

[osc133]: https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md

## Wire protocol

WebSocket at `/api/ws`, gated by the session cookie set during `/?t=<token>`.

- Binary frames: raw PTY bytes both directions.
- Text frames: JSON control messages.
  - Server → client: `{"type":"geometry","cols":N,"rows":M}` on connect
    and every host SIGWINCH.
  - Client → server: `{"type":"ping"}` keepalive.
  - Client → server: `{"type":"override-geometry","cols":N,"rows":M}`
    when raw view wants the PTY reflowed for the phone, and
    `{"type":"release-geometry"}` to restore the host's geometry. The
    server applies the override only while a client holds it.

All parsing of OSC 133 and alt-screen sequences happens client-side. The
server is unchanged regardless of which mobile shape (transcript vs.
xterm) is in use.

## Voice input

Uses the browser's Web Speech API (free, on-device on Apple and recent
Chrome). Recognized phrases pass through a developer-vocabulary layer
before being sent to the PTY:

- "control c", "ctrl c" → `^C`
- "escape" → `Esc`
- "enter" / "return" / "newline" → `\r`
- "up arrow" / "down arrow" / … → arrow keys
- "dot", "slash", "dash", "underscore", "pipe", "colon" → punctuation

Press and hold the joystick to record; release to stop. Recognition
requires HTTPS — that's why `baf` ships its own cert rather than using
plain HTTP.

## Quitting

Three equivalent ways to end a `baf` session from your terminal:

- `baf-quit` — a shim placed on `PATH` for the lifetime of the session.
- `exit` — the spawned shell exits, baf tears down with it.
- `Ctrl-D` on an empty line — same as `exit`.

From the phone, the `leave` button in the mode bar disconnects. That
closes the WebSocket only — your terminal session keeps running, and any
device can scan again (or just revisit the URL, since the session cookie
lasts 24h) to come back.

If something hangs, `BAF_PID` is exported into the spawned shell, so
`kill -TERM $BAF_PID` works as a fallback. From another terminal,
`pkill baf` also does the trick.

## File locations

- TLS cert: `~/.baf/cert.pem` and `~/.baf/key.pem` (regenerated when
  expiring within 30 days, or if the LAN IP no longer matches the SAN).

## Reading order for new contributors / agents

1. `AGENTS.md` — what we're building and the decision log behind it.
2. `internal/pty/session.go` — the PTY model and fan-out.
3. `internal/server/server.go` — auth, WS, control protocol.
4. `web/src/main.ts` — the wiring on the mobile side.
