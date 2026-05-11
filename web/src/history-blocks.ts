// Builds a one-shot list of BlockRecords from a buffer of older PTY
// bytes (the "history" portion of the initial replay). Runs to
// completion synchronously, then the result is prepended to the live
// transcript via a single reducer action.
//
// History blocks use negative ids drawn from their own counter so they
// can never collide with live block ids (which start at 1 and grow).

import { AnsiRenderer } from "./ansi";
import type { BlockRecord } from "./blocks";
import { StreamParser } from "./parser";

export function buildHistoryBlocks(data: Uint8Array): BlockRecord[] {
  const parser = new StreamParser();
  const blocks: BlockRecord[] = [];
  const renderers = new Map<number, AnsiRenderer>();
  let nextId = -1;
  let currentId: number | null = null;
  let inPrompt = false;
  let pendingCommand: string | null = null;

  const close = (exit?: number) => {
    if (currentId == null) return;
    const b = blocks.find((b) => b.id === currentId);
    if (b) {
      b.state = "done";
      if (exit !== undefined) b.exit = exit;
    }
    currentId = null;
  };

  const open = (command: string): number => {
    const id = nextId--;
    renderers.set(id, new AnsiRenderer());
    blocks.push({
      id,
      command,
      state: "running",
      startedAt: 0,
      startedAtClock: 0,
      lines: [],
    });
    currentId = id;
    inPrompt = false;
    pendingCommand = null;
    return id;
  };

  parser.feed(data, (ev) => {
    switch (ev.type) {
      case "prompt-start":
        close();
        inPrompt = true;
        return;
      case "output-start":
        open(pendingCommand ?? "(history)");
        return;
      case "command-end":
        close(ev.exit);
        return;
      case "bytes": {
        let id = currentId;
        if (id == null) {
          if (inPrompt) return;
          id = open("(stream)");
        }
        const renderer = renderers.get(id);
        if (!renderer) return;
        renderer.feed(ev.data);
        const b = blocks.find((b) => b.id === id);
        if (b) b.lines = renderer.lines;
        return;
      }
      case "alt-screen":
      case "cursor":
      case "command-start":
        return;
    }
  });

  // Anything still running at the end of the buffer was truncated by
  // the replay cut — mark it done so the UI doesn't show a perpetually
  // spinning history block.
  close();
  return blocks;
}
