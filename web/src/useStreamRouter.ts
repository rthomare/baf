// Subscribes to PTY bytes coming off the transport and writes them to
// xterm. RAF-coalesced so a burst of small WS frames per animation
// frame turns into a single xterm.write call.
//
// On connect the server replays a small recent "tail" (binary), then
// optionally brackets older "history" bytes with history-start /
// history-end control frames. xterm's scrollback is append-only and
// the tail is delivered first, so writing the older history bytes
// afterwards would reverse the visible order. We drop history bytes
// in raw-only mode — current screen + live stream is what matters.
//
// Lives at the top of the React tree (App) so it boots once.

import { useEffect } from "react";
import { getTransport } from "./transport";
import { getXterm } from "./xterm-singleton";

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

export function useStreamRouter(): void {
  useEffect(() => {
    const t = getTransport();
    const xt = getXterm();

    let inHistory = false;

    let pending: Uint8Array[] = [];
    let rafHandle = 0;

    const flush = () => {
      rafHandle = 0;
      if (pending.length === 0) return;
      const combined = concat(pending);
      pending = [];
      xt.write(combined);
    };

    const offControl = t.onControl((msg) => {
      if (msg.type === "history-start") {
        inHistory = true;
        return;
      }
      if (msg.type === "history-end") {
        inHistory = false;
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
      if (rafHandle !== 0) cancelAnimationFrame(rafHandle);
      pending = [];
    };
  }, []);
}
