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

export function RawTerminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const { status } = useTransport();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xt = getXterm();
    xt.attach(host);
    xt.onData((d) => {
      // Mute outbound terminal-protocol responses while the replay
      // window is open. Replayed bytes can contain DA/DSR/DECRQM
      // queries from prior programs; xterm parses them and emits
      // responses here. Forwarding those to the PTY ends up as user
      // input at zsh's prompt ("command not found: 1", "2c2e026;0$y").
      if (isInReplay()) return;
      getTransport().send(enc.encode(d));
    });
  }, []);

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
