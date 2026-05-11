// xterm.js wrapper. Mounted once and kept in the DOM at all times (just
// hidden when block view is showing) so its buffer survives view
// toggles. Owns the geometry override lifecycle: requests a phone-sized
// PTY when entering raw, releases it on the way out.

import { useEffect, useRef } from "react";
import { getTransport } from "../transport";
import { getXterm } from "../xterm-singleton";
import { useSessionState } from "../SessionContext";
import { useTransport } from "../useTransport";

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
  const cols = Math.max(40, Math.min(160, Math.floor((rect.width - PADDING) / cellW)));
  const rows = Math.max(10, Math.min(80, Math.floor((rect.height - PADDING) / cellH)));
  return { cols, rows };
}

const enc = new TextEncoder();

export function RawTerminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const { viewMode } = useSessionState();
  const { status } = useTransport();

  // Latest viewMode in a ref so the xterm.onData closure (bound once on
  // mount) can gate keystrokes without being re-bound on every flip.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  // Mount xterm once and wire keystrokes to the transport.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const xt = getXterm();
    xt.attach(host);
    xt.onData((d) => {
      if (viewModeRef.current === "raw") getTransport().send(enc.encode(d));
    });
  }, []);

  // Geometry override: hold while raw + connected; release on exit or
  // disconnect. Each request also pins the latest viewport-derived size.
  useEffect(() => {
    if (viewMode !== "raw" || status !== "open") return;
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
  }, [viewMode, status]);

  // Apply geometry from the server whenever it arrives, so xterm
  // matches the PTY size.
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
    <div
      id="xterm-host"
      ref={hostRef}
      hidden={viewMode !== "raw"}
      aria-label="raw terminal"
    />
  );
}
