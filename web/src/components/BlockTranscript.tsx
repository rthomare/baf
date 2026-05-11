import { memo, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import {
  initialBlocksState,
  makeBlockController,
  reduceBlocks,
  type BlockRecord,
} from "../blocks";
import { registerBlockController } from "../block-controller-ref";
import { segmentStyle, type Line } from "../ansi";

const AUTOSCROLL_SLACK_PX = 200;

export function BlockTranscript() {
  const [state, dispatch] = useReducer(reduceBlocks, initialBlocksState);
  const hostRef = useRef<HTMLDivElement>(null);

  // Lazy-init the controller exactly once.
  const controllerRef = useRef<ReturnType<typeof makeBlockController> | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = makeBlockController(dispatch);
    registerBlockController(controllerRef.current);
  }

  // Sync the controller mirror after every commit. Cheap.
  useEffect(() => {
    controllerRef.current?.sync(state);
  }, [state]);

  // Scroll bookkeeping. wasAtBottom tracks whether the user is near
  // the bottom *before* a state change lands; updated continuously
  // from real scroll events so we can preserve intent. lastHeight and
  // lastFirstId let us tell appends from prepends after a layout pass
  // (history blocks arrive after the tail and prepend to the front).
  const wasAtBottomRef = useRef(true);
  const lastHeightRef = useRef(0);
  const lastFirstIdRef = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onScroll = () => {
      const dist = host.scrollHeight - host.scrollTop - host.clientHeight;
      wasAtBottomRef.current = dist < AUTOSCROLL_SLACK_PX;
    };
    host.addEventListener("scroll", onScroll, { passive: true });
    return () => host.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const newHeight = host.scrollHeight;
    const newFirstId = state.blocks[0]?.id ?? null;
    const isPrepend =
      lastFirstIdRef.current !== null &&
      newFirstId !== null &&
      newFirstId !== lastFirstIdRef.current;

    if (wasAtBottomRef.current) {
      host.scrollTop = newHeight;
    } else if (isPrepend) {
      // Older blocks arrived above the user's current viewport. Add
      // the height delta to scrollTop so the content they were
      // reading stays where it was on screen.
      const delta = newHeight - lastHeightRef.current;
      if (delta > 0) host.scrollTop = host.scrollTop + delta;
    }

    lastHeightRef.current = newHeight;
    lastFirstIdRef.current = newFirstId;
  }, [state.blocks]);

  return (
    <div id="transcript" ref={hostRef} aria-label="command transcript">
      {state.blocks.map((b) => (
        <Block key={b.id} block={b} />
      ))}
    </div>
  );
}

// Memoized so that a streaming append to the running block doesn't
// re-render every completed block above it. Block identity is stable
// (reducer returns the same record when its fields don't change), so
// the default shallow prop comparison short-circuits cleanly.
const Block = memo(function Block({ block }: { block: BlockRecord }) {
  return (
    <article className="block" data-state={block.state}>
      <header className="block-header">
        <span className="block-time">{formatTime(block.startedAtClock)}</span>
        <span className={`block-status ${statusClass(block)}`}>
          {statusLabel(block)}
        </span>
      </header>
      <div className="block-command">{block.command}</div>
      <pre className="block-output">
        {block.lines.map((line) => (
          <LineRow key={line.id} line={line} />
        ))}
      </pre>
    </article>
  );
});

const LineRow = memo(function LineRow({ line }: { line: Line }) {
  return (
    <div className="line">
      {line.segments.map((seg, i) => (
        <span key={i} style={segmentStyle(seg.style)}>{seg.text}</span>
      ))}
    </div>
  );
});

function statusClass(b: BlockRecord): string {
  if (b.state === "running") return "";
  if (b.exit === undefined) return "status-ok";
  return b.exit === 0 ? "status-ok" : "status-err";
}

function statusLabel(b: BlockRecord): string {
  if (b.state === "running") return "running";
  const dur = formatDuration(b.durationMs ?? 0);
  if (b.exit === undefined) return `· ${dur}`;
  if (b.exit === 0) return `✓ ${dur}`;
  return `✗ ${b.exit} · ${dur}`;
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}`;
}
