// Block transcript: a Warp/Jupyter-style stream of command blocks. Each
// block has a command, status (running/done), exit code, duration, and a
// list of styled output lines produced by the ANSI renderer.
//
// State shape is pure; the AnsiRenderer instances live in a side-effect
// map keyed by block id (see useBlockTranscript).

import { AnsiRenderer, type Line } from "./ansi";
import type { StreamEvent } from "./parser";

const MAX_BLOCKS = 200;

export interface BlockRecord {
  id: number;
  command: string;
  state: "running" | "done";
  exit?: number;
  startedAt: number;          // performance.now() at output-start
  durationMs?: number;
  startedAtClock: number;     // Date.now() at output-start, for the header timestamp
  lines: Line[];
}

export interface BlocksState {
  blocks: BlockRecord[];
  // Set when the user submits a command; consumed by the next
  // output-start so the block can show its command line.
  pendingCommand: string | null;
  // True between prompt-start and output-start. While we're in the
  // prompt, bytes belong to prompt rendering and we don't open a
  // throwaway "(stream)" block for them.
  inPrompt: boolean;
  // Convenience for callers that need to know the current target id.
  currentId: number | null;
  nextId: number;
}

export const initialBlocksState: BlocksState = {
  blocks: [],
  pendingCommand: null,
  inPrompt: false,
  currentId: null,
  nextId: 1,
};

export type BlockAction =
  | { type: "prompt-start" }
  | { type: "open"; command: string; clock: number; perf: number }
  | { type: "finalize"; exit?: number; perf: number }
  | { type: "lines"; id: number; lines: Line[] }
  | { type: "note-command"; text: string }
  | { type: "reset" };

export function reduceBlocks(state: BlocksState, action: BlockAction): BlocksState {
  switch (action.type) {
    case "prompt-start": {
      // Close any in-flight block as "finished, unknown exit" so it
      // doesn't sit forever as running when a prompt re-appears.
      const next = closeCurrent(state, undefined, performance.now());
      return { ...next, inPrompt: true };
    }
    case "open": {
      const block: BlockRecord = {
        id: state.nextId,
        command: action.command,
        state: "running",
        startedAt: action.perf,
        startedAtClock: action.clock,
        lines: [],
      };
      const blocks = capBlocks([...state.blocks, block]);
      return {
        ...state,
        blocks,
        currentId: block.id,
        nextId: state.nextId + 1,
        inPrompt: false,
        pendingCommand: null,
      };
    }
    case "finalize":
      return closeCurrent(state, action.exit, action.perf);
    case "lines": {
      const blocks = state.blocks.map((b) =>
        b.id === action.id ? { ...b, lines: action.lines } : b,
      );
      return { ...state, blocks };
    }
    case "note-command":
      return { ...state, pendingCommand: action.text };
    case "reset":
      return initialBlocksState;
  }
}

function closeCurrent(state: BlocksState, exit: number | undefined, perf: number): BlocksState {
  if (state.currentId == null) return state;
  const blocks = state.blocks.map((b) => {
    if (b.id !== state.currentId) return b;
    return {
      ...b,
      state: "done" as const,
      exit,
      durationMs: perf - b.startedAt,
    };
  });
  return { ...state, blocks, currentId: null };
}

function capBlocks(blocks: BlockRecord[]): BlockRecord[] {
  if (blocks.length <= MAX_BLOCKS) return blocks;
  return blocks.slice(blocks.length - MAX_BLOCKS);
}

export interface BlockController {
  handle(ev: StreamEvent): void;
  noteSentCommand(text: string): void;
  reset(): void;
  sync(state: BlocksState): void;
}

// Side-effect controller. Owns the renderer-per-block map and decides
// when to open anonymous (stream) blocks. Dispatches into the pure
// reducer above.
//
// The map is intentionally a plain Map keyed by block id; reducer state
// keeps only the rendered Line snapshots.
export function makeBlockController(dispatch: (a: BlockAction) => void): BlockController {
  const renderers = new Map<number, AnsiRenderer>();
  // Mirror of pertinent reducer fields so the controller can branch on
  // current state without making the dispatcher async. Kept in sync via
  // a sync() entry point the consumer calls each render.
  let mirror: { currentId: number | null; inPrompt: boolean; pendingCommand: string | null; nextId: number } = {
    currentId: null,
    inPrompt: false,
    pendingCommand: null,
    nextId: 1,
  };

  function sync(state: BlocksState) {
    mirror = {
      currentId: state.currentId,
      inPrompt: state.inPrompt,
      pendingCommand: state.pendingCommand,
      nextId: state.nextId,
    };
  }

  function openBlock(command: string): number {
    const id = mirror.nextId;
    const renderer = new AnsiRenderer();
    renderers.set(id, renderer);
    dispatch({
      type: "open",
      command,
      clock: Date.now(),
      perf: performance.now(),
    });
    // Optimistic mirror update so the next event in the same batch
    // sees the new id without waiting for the next sync.
    mirror = { ...mirror, currentId: id, nextId: id + 1, inPrompt: false, pendingCommand: null };
    return id;
  }

  function handle(ev: StreamEvent): void {
    switch (ev.type) {
      case "prompt-start":
        dispatch({ type: "prompt-start" });
        mirror = { ...mirror, currentId: null, inPrompt: true };
        return;
      case "output-start":
        openBlock(mirror.pendingCommand ?? "(local)");
        return;
      case "command-end":
        dispatch({ type: "finalize", exit: ev.exit, perf: performance.now() });
        // Keep the renderer around briefly — the same block may still
        // get trailing output bytes before the next prompt-start.
        mirror = { ...mirror, currentId: null };
        return;
      case "bytes": {
        let id = mirror.currentId;
        if (id == null) {
          if (mirror.inPrompt) return; // prompt bytes ignored
          id = openBlock("(stream)");
        }
        const renderer = renderers.get(id);
        if (!renderer) return;
        renderer.feed(ev.data);
        dispatch({ type: "lines", id, lines: renderer.lines });
        return;
      }
      case "alt-screen":
      case "cursor":
        // Handled elsewhere (view-mode flip). Ignored here.
        return;
    }
  }

  function noteSentCommand(text: string) {
    dispatch({ type: "note-command", text: text.replace(/\r$/, "") });
    mirror = { ...mirror, pendingCommand: text.replace(/\r$/, "") };
  }

  function reset() {
    renderers.clear();
    dispatch({ type: "reset" });
    mirror = { currentId: null, inPrompt: false, pendingCommand: null, nextId: 1 };
  }

  return { handle, noteSentCommand, reset, sync };
}
