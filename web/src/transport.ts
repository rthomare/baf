// One WebSocket per page. Components and hooks share this instance via
// getTransport() so we don't open two sockets.
//
// `userDisconnected` distinguishes a user-initiated leave from a dropped
// connection — the StatusOverlay uses it to tailor the hint text.

import { connect, type Transport } from "./ws";

let instance: Transport | null = null;
let userDisconnected = false;

export function getTransport(): Transport {
  if (!instance) instance = connect();
  return instance;
}

export function leaveSession(): void {
  userDisconnected = true;
  getTransport().disconnect();
}

export function rejoinSession(): void {
  userDisconnected = false;
  getTransport().reconnect();
}

export function wasUserInitiated(): boolean {
  return userDisconnected;
}
