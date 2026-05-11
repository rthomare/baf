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

export interface Transport {
  send(bytes: Uint8Array): void;
  control(msg: OutboundControl): void;
  onOutput(cb: (chunk: Uint8Array) => void): void;
  onControl(cb: (msg: InboundControl) => void): void;
  onStatus(cb: (s: Status) => void): void;
  disconnect(): void;
  reconnect(): void;
}

export type Status = "connecting" | "open" | "closed" | "error";

export function connect(): Transport {
  // Same-origin WS. The session cookie set during /?t=token exchange
  // gates this upgrade on the server side.
  const url = new URL("/api/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  let ws: WebSocket | null = null;
  let outputCb: ((c: Uint8Array) => void) | null = null;
  let controlCb: ((m: InboundControl) => void) | null = null;
  let statusCb: ((s: Status) => void) | null = null;
  const outbox: (Uint8Array | string)[] = [];

  const open = () => {
    statusCb?.("connecting");
    try {
      ws = new WebSocket(url.toString());
    } catch {
      statusCb?.("error");
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      statusCb?.("open");
      while (outbox.length) {
        const m = outbox.shift()!;
        if (typeof m === "string") ws!.send(m);
        else ws!.send(m);
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const msg = JSON.parse(ev.data) as InboundControl;
          controlCb?.(msg);
        } catch {
          // ignore malformed control frames
        }
        return;
      }
      outputCb?.(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = () => {
      ws = null;
      statusCb?.("closed");
    };
    ws.onerror = () => {
      statusCb?.("error");
    };
  };
  open();

  const sendRaw = (m: Uint8Array | string) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (typeof m === "string") ws.send(m);
      else ws.send(m);
    } else {
      // Drop while disconnected — the user has explicitly chosen to be
      // offline, replaying staged keystrokes after reconnect would be
      // surprising. Resize/control on reconnect is sent fresh.
    }
  };

  return {
    send: (bytes) => sendRaw(bytes),
    control: (msg) => sendRaw(JSON.stringify(msg)),
    onOutput: (cb) => (outputCb = cb),
    onControl: (cb) => (controlCb = cb),
    onStatus: (cb) => (statusCb = cb),
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
