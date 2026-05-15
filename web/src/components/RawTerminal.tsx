// xterm.js, always mounted. Owns the geometry override lifecycle so
// the PTY is sized for the phone's viewport while a client is
// attached; releases the override on disconnect.

import { useEffect, useRef } from "react";
import { getTransport } from "../transport";
import { getXterm } from "../xterm-singleton";
import { useTransport } from "../useTransport";
import { isInReplay } from "../replay-window";

const FONT = 14;
const CELL_W_RATIO = 0.6;
const LINE_HEIGHT = 1.15;
const PADDING = 12;

function preferredRawGeometry(): { cols: number; rows: number } {
  const view = document.getElementById("view") as HTMLElement | null;
  if (!view) return { cols: 80, rows: 24 };
  const rect = view.getBoundingClientRect();
  const cellW = FONT * CELL_W_RATIO;
  const cellH = FONT * LINE_HEIGHT;
  const cols = Math.max(
    40,
    Math.min(160, Math.floor((rect.width - PADDING) / cellW)),
  );
  const rows = Math.max(
    10,
    Math.min(80, Math.floor((rect.height - PADDING) / cellH)),
  );
  return { cols, rows };
}

const enc = new TextEncoder();

function isProtocolResponse(d: string): boolean {
  if (d.length < 2 || d.charCodeAt(0) !== 0x1b) return false;
  const c = d.charCodeAt(1);
  // `[` = CSI, `]` = OSC, `P` = DCS — the families xterm uses for
  // capability-query replies.
  return c === 0x5b || c === 0x5d || c === 0x50;
}

export function RawTerminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const { status } = useTransport();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xt = getXterm();
    xt.attach(host);
    xt.onData((d) => {
      // The composer is the only typing surface on this client — user
      // input that lands at xterm (physical keyboard, paste, etc.)
      // does NOT reach the PTY. We still forward CSI/OSC sequences
      // because those are responses xterm generates in answer to
      // terminal-capability queries (DA/DSR/DECRQM) issued by
      // programs running in the PTY; muting them breaks vim and
      // friends.
      if (isInReplay()) return;
      if (!isProtocolResponse(d)) return;
      getTransport().send(enc.encode(d));
    });
  }, []);

  // A "protocol response" looks like ESC followed by `[` (CSI), `]`
  // (OSC), or `P` (DCS). Plain typed input — letters, Enter (`\r`),
  // Tab (`\t`), backspace (`\x7f`) — fails this test and is dropped.
  // Arrow keys typed on a physical keyboard would slip through
  // (`\x1b[A`), but the mobile UI doesn't expect physical keyboards,
  // and the joystick path is the supported way to send arrows.

  useEffect(() => {
    if (status !== "open") return;
    const t = getTransport();
    const apply = () => {
      const { cols, rows } = preferredRawGeometry();
      t.control({ type: "override-geometry", cols, rows });
    };
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    window.visualViewport?.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      window.visualViewport?.removeEventListener("resize", apply);
      t.control({ type: "release-geometry" });
    };
  }, [status]);

  useEffect(() => {
    const t = getTransport();
    return t.onControl((msg) => {
      if (msg.type === "geometry") {
        const xt = getXterm();
        requestAnimationFrame(() => xt.setGeometry(msg.cols, msg.rows));
      }
    });
  }, []);

  return (
    <div style={{ height: "100%" }} ref={hostRef} aria-label="raw terminal" />
  );
}
