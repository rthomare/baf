// Subscribes to PTY bytes coming off the transport and routes them
// through the parser into:
//   - xterm.write for every byte chunk
//   - the block transcript for prompt-start/output-start/command-end
//   - session view-mode flips for alt-screen / cursor visibility
//
// On connect the server sends a small recent "tail" first (binary),
// then brackets the older "history" with history-start / history-end
// control frames. Binary frames received between those go through a
// separate buffered parse pass; the resulting blocks are prepended to
// the transcript when history-end arrives, so the user sees the most
// recent context immediately and older context fills in afterwards.
//
// Lives at the top of the React tree (App) so it boots once.

import { useEffect, useRef } from "react";
import { getTransport } from "./transport";
import { getXterm } from "./xterm-singleton";
import { getBlockController } from "./block-controller-ref";
import { StreamParser, type StreamEvent } from "./parser";
import { buildHistoryBlocks } from "./history-blocks";
import { useSessionActions, useSessionState } from "./SessionContext";

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
  const actions = useSessionActions();
  const { viewMode, userPreference } = useSessionState();

  // Refs hold latest viewMode/userPreference so the subscription
  // doesn't re-bind on every change.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const userPrefRef = useRef(userPreference);
  userPrefRef.current = userPreference;

  useEffect(() => {
    const t = getTransport();
    const xt = getXterm();
    const parser = new StreamParser();

    // History-mode plumbing. While inHistory is true, incoming binary
    // chunks are buffered (concatenated) instead of being fed to the
    // live parser or xterm — they belong to an older slice of the
    // stream and need to be parsed independently before being
    // prepended. history-end flushes the buffer.
    let inHistory = false;
    const historyChunks: Uint8Array[] = [];

    const flushHistory = () => {
      if (historyChunks.length === 0) return;
      const buf = concat(historyChunks);
      historyChunks.length = 0;
      const blocks = buildHistoryBlocks(buf);
      getBlockController()?.prependHistory(blocks);
    };

    // Non-bytes events: view-mode flips and block-controller dispatch.
    // Bytes are handled per-mode in flush() below.
    const handleNonBytes = (ev: StreamEvent) => {
      if (ev.type === "alt-screen") {
        // Alt-screen on always forces raw. Off restores user preference,
        // so a user who explicitly chose block doesn't get stuck in raw
        // after vim exits — and a user on the default (raw) stays raw.
        actions.setViewMode(ev.on ? "raw" : userPrefRef.current);
        return;
      }
      if (ev.type === "cursor") {
        // Hide-cursor forces raw (Claude/Codex/Ink inline TUIs). Show-
        // cursor isn't reliable as an exit signal; command-end handles it.
        if (!ev.visible && viewModeRef.current === "block") actions.setViewMode("raw");
        return;
      }
      const controller = getBlockController();
      if (ev.type === "command-end") {
        if (viewModeRef.current === "raw") actions.setViewMode(userPrefRef.current);
        controller?.handle(ev);
        return;
      }
      controller?.handle(ev);
    };

    // RAF-coalesced inbound queue. The PTY can deliver many small WS
    // frames per animation frame on busy output; batching into one
    // combined buffer per RAF turns N parser walks + N xterm.write
    // calls into 1 + 1.
    let pending: Uint8Array[] = [];
    let rafHandle = 0;

    const flush = () => {
      rafHandle = 0;
      if (pending.length === 0) return;
      const combined = concat(pending);
      pending = [];

      if (viewModeRef.current === "raw") {
        // Raw fast path: hand the chunk straight to xterm in one write
        // and only walk the parser to fish out non-bytes signals
        // (alt-screen exit, command-end). The block transcript is not
        // visible, so its controller doesn't need byte-level events.
        xt.write(combined);
        parser.feed(combined, (ev) => {
          if (ev.type === "bytes") return;
          handleNonBytes(ev);
        });
        return;
      }

      // Block mode: keep the parser driving the transcript, but
      // accumulate its `bytes` events and write to xterm in one call
      // at the end of the flush. The block controller still gets
      // per-event handles because it cares about byte boundaries
      // relative to OSC 133 markers.
      const xtBuf: Uint8Array[] = [];
      parser.feed(combined, (ev) => {
        if (ev.type === "bytes") {
          xtBuf.push(ev.data);
          getBlockController()?.handle(ev);
          return;
        }
        handleNonBytes(ev);
      });
      if (xtBuf.length > 0) xt.write(concat(xtBuf));
    };

    const offControl = t.onControl((msg) => {
      if (msg.type === "history-start") {
        inHistory = true;
        return;
      }
      if (msg.type === "history-end") {
        inHistory = false;
        flushHistory();
        return;
      }
    });

    const offOutput = t.onOutput((chunk) => {
      if (inHistory) {
        historyChunks.push(chunk);
        return;
      }
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
  }, [actions]);
}
