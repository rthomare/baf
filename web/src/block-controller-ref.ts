// Single live BlockController, set when the <BlockTranscript> mounts.
// Used by the stream router (forward parser events) and by the session
// commit action (attach the command to the next output-start).

import type { BlockController } from "./blocks";

let current: BlockController | null = null;

export function registerBlockController(c: BlockController): void {
  current = c;
}

export function getBlockController(): BlockController | null {
  return current;
}
