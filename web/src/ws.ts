// WebSocket transport. Binary frames carry raw PTY bytes both directions;
// text frames carry JSON control messages. Reconnection is user-driven —
// we don't auto-retry, so a "disconnect" tap or a dropped link both
// surface the same overlay and the user decides when to come back.

// Outbound control messages. The client asks for an override-geometry
// while a TUI is being driven from the phone, so the PTY reflows to a
// readable size. Release reverts to the host's SIGWINCH-driven size.
type OutboundControl =
  | { type: "ping" }
  | { type: "override-geometry"; cols: number; rows: number }
  | { type: "release-geometry" };

// Inbound control messages. The server pushes geometry on connect and
// whenever the host resizes.
export type InboundControl =
  | { type: "geometry"; cols: number; rows: number };

export type Status = "connecting" | "open" | "closed" | "error";

export interface Transport {
  send(bytes: Uint8Array): void;
  control(msg: OutboundControl): void;
  onOutput(cb: (chunk: Uint8Array) => void): () => void;
  onControl(cb: (msg: InboundControl) => void): () => void;
  onStatus(cb: (s: Status) => void): () => void;
  status(): Status;
  disconnect(): void;
  reconnect(): void;
}

export function connect(): Transport {
  // Same-origin WS. The session cookie set during /?t=token exchange
  // gates this upgrade on the server side.
  const url = new URL("/api/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let ws: WebSocket | null = null;
  let currentStatus: Status = "connecting";
  const outputSubs = new Set<(c: Uint8Array) => void>();
  const controlSubs = new Set<(m: InboundControl) => void>();
  const statusSubs = new Set<(s: Status) => void>();

  const setStatus = (s: Status) => {
    currentStatus = s;
    for (const cb of statusSubs) cb(s);
  };

  const open = () => {
    setStatus("connecting");
    try {
      ws = new WebSocket(url.toString());
    } catch {
      setStatus("error");
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = () => setStatus("open");
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as InboundControl;
          for (const cb of controlSubs) cb(msg);
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      for (const cb of outputSubs) cb(bytes);
    };
    ws.onclose = () => {
      ws = null;
      setStatus("closed");
    };
    ws.onerror = () => setStatus("error");
  };
  open();

  const sendRaw = (m: Uint8Array | string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (typeof m === "string") ws.send(m);
      else ws.send(m);
    }
    // Dropped while disconnected — the user has explicitly chosen to be
    // offline. Replaying staged keystrokes after reconnect would be
    // surprising.
  };

  return {
    send: (bytes) => sendRaw(bytes),
    control: (msg) => sendRaw(JSON.stringify(msg)),
    onOutput: (cb) => { outputSubs.add(cb); return () => outputSubs.delete(cb); },
    onControl: (cb) => { controlSubs.add(cb); return () => controlSubs.delete(cb); },
    onStatus: (cb) => { statusSubs.add(cb); return () => statusSubs.delete(cb); },
    status: () => currentStatus,
    disconnect: () => {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close(1000, "user disconnect");
      }
    },
    reconnect: () => {
      if (ws && ws.readyState !== WebSocket.CLOSED) return;
      open();
    },
  };
}
