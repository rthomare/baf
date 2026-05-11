// Action helpers that go straight through the transport singleton.
// Used by components that need to send keystrokes without dispatching
// session actions first.

import { keyToBytes } from "./keys";
import { getTransport } from "./transport";

const enc = new TextEncoder();

export function pressKey(name: string): void {
  const bytes = keyToBytes(name);
  if (bytes) getTransport().send(enc.encode(bytes));
}
