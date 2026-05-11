// Block transcript renderer.
//
// Driven by StreamEvents from the parser:
//
//   prompt-start  → close any in-flight block, prepare a pending one
//   output-start  → pending block transitions to "running"; attach the
//                   command we know was just sent (if any)
//   command-end   → finalize the running block with exit code + duration
//   bytes         → routed through an AnsiRenderer into the running
//                   (or pending — host typed directly) block's output
//
// We deliberately keep "host typed directly" support: if the user runs
// commands at the laptop without using the composer, the block UI still
// shows them — we just can't attribute a command line to them. The
// block's command field falls back to "(local)".

import { AnsiRenderer } from "./ansi";
import type { StreamEvent } from "./parser";

interface Block {
  id: number;
  el: HTMLElement;
  output: HTMLElement;
  renderer: AnsiRenderer;
  startedAt: number;
  command: string | null;
  finished: boolean;
}

export class BlockTranscript {
  private host: HTMLElement;
  private blocks: Block[] = [];
  private nextId = 1;
  private current: Block | null = null;
  // Pending state: we've seen prompt-start but not yet output-start. The
  // user might be typing at the host or composing on mobile. We don't
  // open a visible block until output-start so the transcript doesn't
  // fill with empty prompt blocks.
  private inPrompt = false;
  // Command the user just sent via the composer — attached to the next
  // output-start.
  private pendingCommand: string | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  // Called by main.ts whenever the composer sends a command, so the
  // next block knows what its title should be.
  noteSentCommand(cmd: string): void {
    this.pendingCommand = cmd.replace(/\r$/, "");
  }

  handle(ev: StreamEvent): void {
    switch (ev.type) {
      case "prompt-start":
        this.closeBlock();
        this.inPrompt = true;
        break;

      case "output-start": {
        const b = this.openBlock(this.pendingCommand ?? "(local)");
        this.pendingCommand = null;
        this.current = b;
        this.inPrompt = false;
        break;
      }

      case "command-end":
        this.finalize(ev.exit);
        break;

      case "bytes":
        // If we get output without a prior output-start (host typed
        // before we hooked, or shell didn't emit OSC 133), open an
        // anonymous block on the fly.
        if (!this.current && !this.inPrompt) {
          this.current = this.openBlock("(stream)");
        }
        if (this.current) {
          this.current.renderer.feed(ev.data);
          this.autoScroll();
        }
        break;

      case "alt-screen":
        // Handled by main.ts (mode flip).
        break;
    }
  }

  clear(): void {
    this.host.replaceChildren();
    this.blocks = [];
    this.current = null;
    this.inPrompt = false;
    this.pendingCommand = null;
  }

  private openBlock(command: string): Block {
    const el = document.createElement("article");
    el.className = "block";
    el.dataset.state = "running";

    const header = document.createElement("header");
    header.className = "block-header";
    const time = document.createElement("span");
    time.className = "block-time";
    time.textContent = formatTime(new Date());
    const status = document.createElement("span");
    status.className = "block-status";
    status.textContent = "running";
    header.appendChild(time);
    header.appendChild(status);

    const cmd = document.createElement("div");
    cmd.className = "block-command";
    cmd.textContent = command;

    const output = document.createElement("pre");
    output.className = "block-output";

    el.appendChild(header);
    el.appendChild(cmd);
    el.appendChild(output);
    this.host.appendChild(el);

    const block: Block = {
      id: this.nextId++,
      el,
      output,
      renderer: new AnsiRenderer(output),
      startedAt: performance.now(),
      command,
      finished: false,
    };
    this.blocks.push(block);
    // Cap the block list so memory doesn't grow forever.
    if (this.blocks.length > 200) {
      const drop = this.blocks.shift();
      drop?.el.remove();
    }
    return block;
  }

  private finalize(exit?: number): void {
    if (!this.current) return;
    const durationMs = performance.now() - this.current.startedAt;
    const status = this.current.el.querySelector(".block-status") as HTMLElement;
    const okClass = exit === undefined || exit === 0 ? "status-ok" : "status-err";
    status.classList.add(okClass);
    const dur = formatDuration(durationMs);
    if (exit === undefined) {
      status.textContent = `· ${dur}`;
    } else if (exit === 0) {
      status.textContent = `✓ ${dur}`;
    } else {
      status.textContent = `✗ ${exit} · ${dur}`;
    }
    this.current.el.dataset.state = "done";
    this.current.finished = true;
    this.current = null;
  }

  private closeBlock(): void {
    if (this.current && !this.current.finished) this.finalize(undefined);
  }

  private autoScroll(): void {
    // Only autoscroll if the user is already near the bottom — they
    // might be reading history.
    const nearBottom = this.host.scrollHeight - this.host.scrollTop - this.host.clientHeight < 200;
    if (nearBottom) {
      this.host.scrollTop = this.host.scrollHeight;
    }
  }
}

function formatTime(d: Date): string {
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
