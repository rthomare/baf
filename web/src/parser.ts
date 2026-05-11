// Streaming byte → event parser.
//
// We extract two classes of out-of-band signals from the PTY stream:
//
//   - OSC 133;A/B/C/D — block lifecycle (from the shell-injected hooks).
//   - CSI ?1049h/?47h/?1047h and matching ?l — alternate-screen toggles,
//     used to know when something is taking over the whole screen
//     (vim, htop, less, …) so the client can flip into raw mode.
//
// Anything else — plain text, SGR for colour, other CSI/OSC sequences —
// is passed through verbatim as `bytes` events. Downstream renderers
// (block transcript SGR parser, or xterm.js in raw mode) handle it.
//
// The parser is stateful across `feed` calls so chunk boundaries cutting
// a sequence in half don't cause false text emission.

export type StreamEvent =
  | { type: "bytes"; data: Uint8Array }
  | { type: "prompt-start" }
  | { type: "command-start" }
  | { type: "output-start" }
  | { type: "command-end"; exit?: number }
  | { type: "alt-screen"; on: boolean }
  // Cursor visibility — strong TUI signal. Apps that redraw inline
  // (Claude Code, Ink-based tools, fzf without alt-screen) hide the
  // cursor at startup. The mobile client uses this to flip to raw mode
  // even when no alt-screen sequence is emitted.
  | { type: "cursor"; visible: boolean };

const ESC = 0x1b;
const BEL = 0x07;

type State = "ground" | "esc" | "csi" | "osc" | "osc-st";

export class StreamParser {
  private state: State = "ground";
  // Bytes that belong to the in-progress escape sequence — we keep them
  // so we can re-emit them as `bytes` if it turns out we don't care
  // about the sequence (e.g. an SGR colour change).
  private seqBuf: number[] = [];

  feed(bytes: Uint8Array, emit: (ev: StreamEvent) => void): void {
    // Plain-text run within this chunk. Flushed as one `bytes` event at
    // ESC boundaries or end-of-chunk for efficiency.
    let runStart = 0;

    const flushRun = (end: number) => {
      if (end > runStart) {
        emit({ type: "bytes", data: bytes.subarray(runStart, end) });
      }
    };

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (this.state) {
        case "ground":
          if (b === ESC) {
            flushRun(i);
            runStart = i + 1; // unused while not in ground
            this.state = "esc";
            this.seqBuf = [ESC];
          }
          break;

        case "esc":
          this.seqBuf.push(b);
          if (b === 0x5b /* [ */) {
            this.state = "csi";
          } else if (b === 0x5d /* ] */) {
            this.state = "osc";
          } else {
            // Some other ESC X form (charset selection, etc.). Pass
            // through as bytes.
            this.emitSeq(emit);
            this.state = "ground";
            runStart = i + 1;
          }
          break;

        case "csi":
          this.seqBuf.push(b);
          if (b >= 0x40 && b <= 0x7e) {
            // Final byte; sequence complete.
            this.handleCSI(emit);
            this.state = "ground";
            runStart = i + 1;
          }
          break;

        case "osc":
          if (b === BEL) {
            this.handleOSC(emit);
            this.state = "ground";
            runStart = i + 1;
          } else if (b === ESC) {
            // Possible ST terminator (ESC \). Hold off.
            this.state = "osc-st";
          } else {
            this.seqBuf.push(b);
          }
          break;

        case "osc-st":
          if (b === 0x5c /* \ */) {
            this.handleOSC(emit);
            this.state = "ground";
            runStart = i + 1;
          } else {
            // Not ST — push back the ESC we swallowed and resume OSC.
            this.seqBuf.push(ESC, b);
            this.state = "osc";
          }
          break;
      }
    }

    if (this.state === "ground") {
      flushRun(bytes.length);
    }
  }

  private handleCSI(emit: (ev: StreamEvent) => void): void {
    // seqBuf contains [ESC, '[', …, final].
    const params = this.seqBuf.slice(2, -1);
    const final = this.seqBuf[this.seqBuf.length - 1];
    // DEC private mode: ESC [ ? <num>[;<num>...] <h|l>. We extract the
    // ones we care about as signal events, but still pass the raw bytes
    // through so xterm.js (when it's the renderer) can update its
    // internal alt-screen / cursor-visibility state correctly.
    if (params.length >= 2 && params[0] === 0x3f /* ? */ && (final === 0x68 /* h */ || final === 0x6c /* l */)) {
      const on = final === 0x68;
      const nums = String.fromCharCode(...params.slice(1)).split(";");
      for (const n of nums) {
        if (n === "1049" || n === "47" || n === "1047") {
          emit({ type: "alt-screen", on });
        } else if (n === "25") {
          emit({ type: "cursor", visible: on });
        }
      }
    }
    // Always pass through. ANSI renderer ignores anything it doesn't
    // recognize; xterm relies on these bytes for state.
    this.emitSeq(emit);
  }

  private handleOSC(emit: (ev: StreamEvent) => void): void {
    // seqBuf contains [ESC, ']', …payload]; no terminator byte is
    // included because the state machine consumed it.
    const payload = String.fromCharCode(...this.seqBuf.slice(2));
    if (payload.startsWith("133;")) {
      const rest = payload.slice(4);
      // rest is "A", "B", "C", "D", or "D;<exit>", possibly with extra
      // semicolon-separated params we ignore.
      const code = rest.charAt(0);
      switch (code) {
        case "A":
          emit({ type: "prompt-start" });
          this.seqBuf = [];
          return;
        case "B":
          emit({ type: "command-start" });
          this.seqBuf = [];
          return;
        case "C":
          emit({ type: "output-start" });
          this.seqBuf = [];
          return;
        case "D": {
          let exit: number | undefined;
          const parts = rest.split(";");
          if (parts.length > 1) {
            const n = parseInt(parts[1], 10);
            if (!Number.isNaN(n)) exit = n;
          }
          emit({ type: "command-end", exit });
          this.seqBuf = [];
          return;
        }
      }
    }
    // Anything else (window title, hyperlinks, terminal-specific OSCs):
    // pass through with a synthetic BEL terminator so downstream sees
    // a well-formed sequence.
    this.seqBuf.push(BEL);
    this.emitSeq(emit);
  }

  private emitSeq(emit: (ev: StreamEvent) => void): void {
    emit({ type: "bytes", data: Uint8Array.from(this.seqBuf) });
    this.seqBuf = [];
  }
}
