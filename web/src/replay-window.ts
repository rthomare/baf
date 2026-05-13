// Tracks whether the transport is currently inside its post-connect
// replay window (tail + history). Replayed bytes may contain DA / DSR /
// DECRQM queries from earlier programs; xterm.js's parser sees the
// queries and emits responses via term.onData. Forwarding those
// responses back to the PTY (where the shell is sitting at a prompt)
// produces visible gibberish like "zsh: command not found: 1" and
// "1;2c2e026;0$y". RawTerminal reads isInReplay() to decide whether to
// forward outbound terminal-protocol responses; useStreamRouter owns
// the lifecycle (arm on connect, disarm after replay-end + rAF).

let inReplay = true;

export function isInReplay(): boolean {
  return inReplay;
}

export function markReplayActive(): void {
  inReplay = true;
}

export function markReplayDone(): void {
  inReplay = false;
}
