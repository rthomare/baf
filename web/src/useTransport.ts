// Subscribes a component to the shared transport. Returns the live
// connection status and a stable handle to send/control/leave/rejoin.

import { useEffect, useState } from "react";
import {
  getTransport,
  leaveSession,
  rejoinSession,
  wasUserInitiated,
} from "./transport";
import type { Status } from "./ws";

export interface TransportHandle {
  status: Status;
  userInitiated: boolean;
  send: (bytes: Uint8Array) => void;
  leave: () => void;
  rejoin: () => void;
}

export function useTransport(): TransportHandle {
  const t = getTransport();
  const [status, setStatus] = useState<Status>(t.status());

  useEffect(() => t.onStatus(setStatus), [t]);

  return {
    status,
    userInitiated: wasUserInitiated(),
    send: (b) => t.send(b),
    leave: leaveSession,
    rejoin: rejoinSession,
  };
}
