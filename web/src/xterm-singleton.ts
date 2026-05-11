// One xterm.js Terminal for the whole session. RawTerminal mounts it
// into the visible host; the stream router writes bytes to it on every
// chunk, regardless of which view is showing.

import { createTerm, type Term } from "./terminal";

let instance: Term | null = null;

export function getXterm(): Term {
  if (!instance) instance = createTerm();
  return instance;
}
