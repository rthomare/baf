// Subscribes to PTY bytes coming off the transport and writes them to
// xterm. RAF-coalesced so a burst of small WS frames per animation
// frame turns into a single xterm.write call.
//
// On connect the server replays a small recent "tail" (binary), then
// optionally brackets older "history" bytes with history-start /
// history-end control frames, and caps the whole thing with a
// replay-end marker. We drop history bytes in raw-only mode (current
// screen + live stream is what matters), and we mute outbound xterm
// terminal-protocol responses while the replay window is active —
// otherwise DA/DSR/DECRQM queries embedded in the replayed bytes echo
// back to the PTY as gibberish input.
//
// Lives at the top of the React tree (App) so it boots once.

import { useEffect } from "react";
import { getTransport } from "./transport";
import { getXterm } from "./xterm-singleton";
import {
  markReplayActive,
  markReplayDone,
} from "./replay-window";
import { useSessionActions } from "./SessionContext";

const concat = (chunks: Uint8Array[]): Uint8Array => {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return buf;
};

// Hard safety: if the server never sends replay-end (older binary,
// unexpected disconnect mid-replay), don't stay muted forever.
const REPLAY_SAFETY_MS = 2000;

export function useStreamRouter(): void {
  const sessionActions = useSessionActions();
  useEffect(() => {
    const t = getTransport();
    const xt = getXterm();

    let inHistory = false;

    let pending: Uint8Array[] = [];
    let rafHandle = 0;
    let safety: number | null = null;

    const flush = () => {
      rafHandle = 0;
      if (pending.length === 0) return;
      const combined = concat(pending);
      pending = [];
      xt.write(combined);
    };

    const armReplay = () => {
      markReplayActive();
      if (safety !== null) clearTimeout(safety);
      safety = window.setTimeout(() => {
        markReplayDone();
        safety = null;
      }, REPLAY_SAFETY_MS);
    };
    armReplay();

    const offStatus = t.onStatus((s) => {
      // Each new connection re-replays tail+history, so re-arm the
      // mute window. "open" is enough — "connecting" alone never
      // produces inbound bytes.
      if (s === "open") armReplay();
    });

    const offControl = t.onControl((msg) => {
      if (msg.type === "history-start") {
        inHistory = true;
        return;
      }
      if (msg.type === "history-end") {
        inHistory = false;
        return;
      }
      if (msg.type === "replay-end") {
        // Defer the unmute until after any queued binary chunks have
        // been flushed to xterm. xt.write fires onData synchronously
        // for embedded DA queries, so we need to still be muted when
        // that happens. Two rAFs cover the same-frame flush plus any
        // xterm-internal async parsing.
        if (safety !== null) {
          clearTimeout(safety);
          safety = null;
        }
        requestAnimationFrame(() => {
          requestAnimationFrame(markReplayDone);
        });
        return;
      }
      if (msg.type === "project") {
        sessionActions.setProject(msg.project);
        return;
      }
    });

    const offOutput = t.onOutput((chunk) => {
      if (inHistory) return;
      pending.push(chunk);
      if (rafHandle === 0) {
        rafHandle = requestAnimationFrame(flush);
      }
    });

    return () => {
      offOutput();
      offControl();
      offStatus();
      if (rafHandle !== 0) cancelAnimationFrame(rafHandle);
      if (safety !== null) clearTimeout(safety);
      pending = [];
    };
  }, [sessionActions]);
}
