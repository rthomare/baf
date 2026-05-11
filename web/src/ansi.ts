// ANSI byte-stream → styled-line producer. Pure data: each feed() updates
// an internal `lines` array of `{id, segments}` records that React can
// render directly. Handles enough of the protocol to make typical shell
// output legible:
//
//   - UTF-8 text         → segments with the active style
//   - SGR (CSI ... m)    → updates the active style
//   - \n                 → new line
//   - \r                 → reset cursor to column 0 (used by progress bars)
//   - \b                 → backspace one column
//   - CSI K              → clear from cursor to end of line (mode 0/2)
//
// Anything else (cursor moves, hyperlinks, …) is silently dropped — if a
// tool uses those it's almost certainly using the alternate screen, in
// which case the client has already flipped to raw mode.

const ESC = 0x1b;
const decoder = new TextDecoder("utf-8", { fatal: false });

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export interface Segment {
  text: string;
  style: AnsiStyle;
}

export interface Line {
  id: number;
  segments: Segment[];
}

const SGR_COLORS: Record<number, string> = {
  30: "#0b0b0b", 31: "#e06c75", 32: "#8ec07c", 33: "#e5c07b",
  34: "#7aa6da", 35: "#c678dd", 36: "#56b6c2", 37: "#d7d7d7",
  90: "#5c5c5c", 91: "#ef8a92", 92: "#a8d49a", 93: "#f0d28a",
  94: "#9bbef0", 95: "#dba6ef", 96: "#7fd0d8", 97: "#ffffff",
};

export class AnsiRenderer {
  private linesArr: Line[] = [];
  private cursorCol = 0;
  private style: AnsiStyle = {};
  // Partial UTF-8 bytes held over a chunk boundary so we don't decode
  // half a character.
  private utf8Pending: Uint8Array = new Uint8Array(0);
  // Buffer for an in-progress ANSI sequence (we only act on SGR and
  // line-clear; the StreamParser absorbs the rest).
  private seq: number[] = [];
  private inEsc = false;
  private nextId = 1;

  constructor() {
    this.newLine();
  }

  // Current lines. The array reference changes whenever feed() touches a
  // line; unchanged Line records retain identity so React can keep keys
  // stable across renders.
  get lines(): Line[] {
    return this.linesArr;
  }

  feed(bytes: Uint8Array): void {
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];

      if (this.inEsc) {
        this.seq.push(b);
        if (this.seq[0] === 0x5b /* [ */ && b >= 0x40 && b <= 0x7e) {
          this.applyCSI();
          this.seq = [];
          this.inEsc = false;
        } else if (this.seq.length > 64) {
          this.seq = [];
          this.inEsc = false;
        }
        i++;
        continue;
      }

      if (b === ESC) {
        this.inEsc = true;
        this.seq = [];
        i++;
        continue;
      }

      if (b === 0x0a /* \n */) {
        this.newLine();
        i++;
        continue;
      }
      if (b === 0x0d /* \r */) {
        this.cursorCol = 0;
        i++;
        continue;
      }
      if (b === 0x08 /* \b */) {
        if (this.cursorCol > 0) this.cursorCol--;
        i++;
        continue;
      }
      if (b < 0x20 && b !== 0x09) {
        i++;
        continue;
      }

      const start = i;
      while (i < bytes.length) {
        const c = bytes[i];
        if (c === ESC || c === 0x0a || c === 0x0d || c === 0x08 || (c < 0x20 && c !== 0x09)) break;
        i++;
      }
      this.writeText(bytes.subarray(start, i));
    }
  }

  private writeText(bytes: Uint8Array): void {
    let buf = bytes;
    if (this.utf8Pending.length > 0) {
      const merged = new Uint8Array(this.utf8Pending.length + bytes.length);
      merged.set(this.utf8Pending);
      merged.set(bytes, this.utf8Pending.length);
      buf = merged;
      this.utf8Pending = new Uint8Array(0);
    }
    const cont = trailingContinuation(buf);
    if (cont > 0) {
      this.utf8Pending = buf.subarray(buf.length - cont);
      buf = buf.subarray(0, buf.length - cont);
    }
    if (buf.length === 0) return;
    const text = decoder.decode(buf);
    this.placeText(text);
  }

  // Writes text at the cursor. Append fast-path if the cursor is at end;
  // otherwise rebuilds the line, replacing [col, col+text.length). Style
  // continuity for surrounding text is approximated as plain — matches
  // the previous DOM implementation, good enough for progress-bar redraws.
  private placeText(text: string): void {
    const last = this.last();
    const lineText = lineToText(last);
    if (this.cursorCol === lineText.length) {
      const next: Line = {
        id: last.id,
        segments: [...last.segments, { text, style: this.style }],
      };
      this.replaceLast(next);
      this.cursorCol += text.length;
      return;
    }
    const before = lineText.slice(0, this.cursorCol);
    const after = lineText.slice(this.cursorCol + text.length);
    const segments: Segment[] = [];
    if (before) segments.push({ text: before, style: {} });
    segments.push({ text, style: this.style });
    if (after) segments.push({ text: after, style: {} });
    this.replaceLast({ id: last.id, segments });
    this.cursorCol += text.length;
  }

  private newLine(): void {
    const line: Line = { id: this.nextId++, segments: [] };
    this.linesArr = [...this.linesArr, line];
    this.cursorCol = 0;
  }

  private last(): Line {
    return this.linesArr[this.linesArr.length - 1];
  }

  private replaceLast(line: Line): void {
    this.linesArr = [...this.linesArr.slice(0, -1), line];
  }

  private applyCSI(): void {
    const seq = this.seq;
    const final = seq[seq.length - 1];
    const paramStr = String.fromCharCode(...seq.slice(1, -1));
    const params = paramStr.split(";").map((p) => (p === "" ? 0 : parseInt(p, 10)));

    if (final === 0x6d /* m */) {
      this.applySGR(params);
    } else if (final === 0x4b /* K */) {
      // Clear in line. 0: cursor to end. 2: entire line.
      const mode = params[0] ?? 0;
      const last = this.last();
      if (mode === 0) {
        const lineText = lineToText(last);
        const keep = lineText.slice(0, this.cursorCol);
        const segments: Segment[] = keep ? [{ text: keep, style: {} }] : [];
        this.replaceLast({ id: last.id, segments });
      } else if (mode === 2) {
        this.replaceLast({ id: last.id, segments: [] });
        this.cursorCol = 0;
      }
    }
  }

  private applySGR(rawParams: number[]): void {
    const params = rawParams.length === 0 ? [0] : rawParams;
    let i = 0;
    while (i < params.length) {
      const p = params[i];
      if (p === 0) this.style = {};
      else if (p === 1) this.style = { ...this.style, bold: true };
      else if (p === 2) this.style = { ...this.style, dim: true };
      else if (p === 3) this.style = { ...this.style, italic: true };
      else if (p === 4) this.style = { ...this.style, underline: true };
      else if (p === 7) this.style = { ...this.style, inverse: true };
      else if (p === 22) this.style = { ...this.style, bold: false, dim: false };
      else if (p === 23) this.style = { ...this.style, italic: false };
      else if (p === 24) this.style = { ...this.style, underline: false };
      else if (p === 27) this.style = { ...this.style, inverse: false };
      else if (p === 39) this.style = { ...this.style, fg: undefined };
      else if (p === 49) this.style = { ...this.style, bg: undefined };
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        this.style = { ...this.style, fg: SGR_COLORS[p] };
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        this.style = { ...this.style, bg: SGR_COLORS[p - 10] };
      } else if (p === 38 || p === 48) {
        const target: "fg" | "bg" = p === 38 ? "fg" : "bg";
        const mode = params[i + 1];
        if (mode === 5) {
          this.style = { ...this.style, [target]: palette256(params[i + 2]) };
          i += 3;
          continue;
        } else if (mode === 2) {
          const r = params[i + 2], g = params[i + 3], bl = params[i + 4];
          this.style = { ...this.style, [target]: `rgb(${r},${g},${bl})` };
          i += 5;
          continue;
        }
      }
      i++;
    }
  }
}

function lineToText(line: Line): string {
  let s = "";
  for (const seg of line.segments) s += seg.text;
  return s;
}

// CSS-style props derived from an AnsiStyle. Returned shape is
// structurally compatible with React.CSSProperties so we don't have to
// pull React into this otherwise framework-agnostic module.
export interface SegmentCss {
  color?: string;
  backgroundColor?: string;
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: "underline";
  opacity?: number;
}

export function segmentStyle(s: AnsiStyle): SegmentCss {
  const out: SegmentCss = {};
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) {
    const tmp = fg ?? "var(--fg)";
    fg = bg ?? "var(--bg)";
    bg = tmp;
  }
  if (fg) out.color = fg;
  if (bg) out.backgroundColor = bg;
  if (s.bold) out.fontWeight = "bold";
  if (s.italic) out.fontStyle = "italic";
  if (s.underline) out.textDecoration = "underline";
  if (s.dim) out.opacity = 0.7;
  return out;
}

function trailingContinuation(buf: Uint8Array): number {
  let count = 0;
  for (let i = buf.length - 1; i >= 0 && i >= buf.length - 4; i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) {
      count++;
      continue;
    }
    if ((b & 0xe0) === 0xc0 && count < 1) return count + 1;
    if ((b & 0xf0) === 0xe0 && count < 2) return count + 1;
    if ((b & 0xf8) === 0xf0 && count < 3) return count + 1;
    return 0;
  }
  return 0;
}

function palette256(n: number): string {
  if (n < 16) {
    const basic = [0, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97];
    return SGR_COLORS[basic[n] ?? 37] ?? "#d7d7d7";
  }
  if (n >= 232) {
    const v = Math.round((n - 232) * 255 / 23);
    return `rgb(${v},${v},${v})`;
  }
  const c = n - 16;
  const r = Math.floor(c / 36), g = Math.floor((c % 36) / 6), b = c % 6;
  const step = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${step(r)},${step(g)},${step(b)})`;
}
