// Tiny ANSI byte-stream renderer for the block transcript.
//
// We feed it the `bytes` events from the StreamParser and it produces
// styled DOM. It handles enough of the protocol to make typical shell
// output legible:
//
//   - UTF-8 text         → spans with the current style
//   - SGR (CSI ... m)    → updates the active style
//   - \n                 → new line
//   - \r                 → reset cursor to column 0 (used by progress bars)
//   - \b                 → backspace one column
//   - CSI K              → clear from cursor to end of line
//   - CSI 2K             → clear entire line
//
// Anything else (cursor moves, hyperlinks, …) is silently dropped — if
// a tool uses those, it's probably also using the alternate screen, in
// which case the client has already flipped to raw mode.

const ESC = 0x1b;
const decoder = new TextDecoder("utf-8", { fatal: false });

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

const SGR_COLORS: Record<number, string> = {
  30: "#0b0b0b", 31: "#e06c75", 32: "#8ec07c", 33: "#e5c07b",
  34: "#7aa6da", 35: "#c678dd", 36: "#56b6c2", 37: "#d7d7d7",
  90: "#5c5c5c", 91: "#ef8a92", 92: "#a8d49a", 93: "#f0d28a",
  94: "#9bbef0", 95: "#dba6ef", 96: "#7fd0d8", 97: "#ffffff",
};

export class AnsiRenderer {
  // Each child of `host` is a line element (<div class="line">). The
  // last child is the line currently being written to.
  private host: HTMLElement;
  private currentLine!: HTMLElement;
  private cursorCol = 0;       // logical column within currentLine
  private style: Style = {};
  // Partial UTF-8 bytes held over a chunk boundary so we don't decode
  // half a character.
  private utf8Pending: Uint8Array = new Uint8Array(0);
  // Buffer for an in-progress ANSI sequence (we only care about SGR and
  // line-clear here; everything else routes through StreamParser).
  private seq: number[] = [];
  private inEsc = false;

  constructor(host: HTMLElement) {
    this.host = host;
    this.newLine();
  }

  feed(bytes: Uint8Array): void {
    // Walk byte-by-byte but accumulate runs of text bytes to decode
    // efficiently. UTF-8 continuation bytes >=0x80 are fine in runs.
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
          // Runaway, abandon
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
        // Drop other control chars (we keep \t at 0x09).
        i++;
        continue;
      }

      // Text run: walk until the next control byte.
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
    // Combine with any pending UTF-8 continuation bytes from last feed.
    let buf = bytes;
    if (this.utf8Pending.length > 0) {
      const merged = new Uint8Array(this.utf8Pending.length + bytes.length);
      merged.set(this.utf8Pending);
      merged.set(bytes, this.utf8Pending.length);
      buf = merged;
      this.utf8Pending = new Uint8Array(0);
    }
    // If the tail is mid-codepoint, hold it for next feed.
    const cont = trailingContinuation(buf);
    if (cont > 0) {
      this.utf8Pending = buf.subarray(buf.length - cont);
      buf = buf.subarray(0, buf.length - cont);
    }
    if (buf.length === 0) return;
    const text = decoder.decode(buf);
    this.placeText(text);
  }

  // placeText writes text at the current cursor column. If the cursor is
  // mid-line (because of a preceding \r), we overwrite the existing
  // content from that column.
  private placeText(text: string): void {
    // Fast path: cursor at end of line — append a new span.
    const line = this.currentLine;
    const lineText = line.textContent ?? "";
    if (this.cursorCol === lineText.length) {
      const span = document.createElement("span");
      applyStyle(span, this.style);
      span.textContent = text;
      line.appendChild(span);
      this.cursorCol += text.length;
      return;
    }
    // Overwrite path: rebuild the line. Replace the substring
    // [cursorCol, cursorCol+text.length) with `text`, keeping anything
    // after intact. Style continuity is approximated by collapsing to
    // a single span — good enough for progress-bar rewrites.
    const before = lineText.slice(0, this.cursorCol);
    const after = lineText.slice(this.cursorCol + text.length);
    line.replaceChildren();
    if (before) {
      const s = document.createElement("span");
      s.textContent = before;
      line.appendChild(s);
    }
    const s = document.createElement("span");
    applyStyle(s, this.style);
    s.textContent = text;
    line.appendChild(s);
    if (after) {
      const t = document.createElement("span");
      t.textContent = after;
      line.appendChild(t);
    }
    this.cursorCol += text.length;
  }

  private newLine(): void {
    this.currentLine = document.createElement("div");
    this.currentLine.className = "line";
    this.host.appendChild(this.currentLine);
    this.cursorCol = 0;
  }

  private applyCSI(): void {
    const seq = this.seq;
    const final = seq[seq.length - 1];
    const paramStr = String.fromCharCode(...seq.slice(1, -1));
    const params = paramStr.split(";").map((p) => (p === "" ? 0 : parseInt(p, 10)));

    if (final === 0x6d /* m */) {
      // SGR
      this.applySGR(params);
    } else if (final === 0x4b /* K */) {
      // Clear in line. 0 (default): cursor to end. 1: start to cursor. 2: entire line.
      const mode = params[0] ?? 0;
      const lineText = this.currentLine.textContent ?? "";
      if (mode === 0) {
        // Truncate to cursor.
        const keep = lineText.slice(0, this.cursorCol);
        this.currentLine.replaceChildren();
        if (keep) {
          const s = document.createElement("span");
          s.textContent = keep;
          this.currentLine.appendChild(s);
        }
      } else if (mode === 2) {
        this.currentLine.replaceChildren();
        this.cursorCol = 0;
      }
    }
    // Other CSI (cursor moves, etc.) — ignore. TUIs use alt-screen, so
    // anything cursor-positioning in the main screen is best-effort.
  }

  private applySGR(params: number[]): void {
    let i = 0;
    if (params.length === 0) params = [0];
    while (i < params.length) {
      const p = params[i];
      if (p === 0) {
        this.style = {};
      } else if (p === 1) this.style.bold = true;
      else if (p === 2) this.style.dim = true;
      else if (p === 3) this.style.italic = true;
      else if (p === 4) this.style.underline = true;
      else if (p === 7) this.style.inverse = true;
      else if (p === 22) { this.style.bold = false; this.style.dim = false; }
      else if (p === 23) this.style.italic = false;
      else if (p === 24) this.style.underline = false;
      else if (p === 27) this.style.inverse = false;
      else if (p === 39) this.style.fg = undefined;
      else if (p === 49) this.style.bg = undefined;
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) {
        this.style.fg = SGR_COLORS[p];
      } else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) {
        this.style.bg = SGR_COLORS[p - 10];
      } else if (p === 38 || p === 48) {
        // 256-colour or RGB: ESC [ 38;5;N m  or  ESC [ 38;2;R;G;B m
        const target = p === 38 ? "fg" : "bg";
        const mode = params[i + 1];
        if (mode === 5) {
          const idx = params[i + 2];
          this.style[target] = palette256(idx);
          i += 3;
          continue;
        } else if (mode === 2) {
          const r = params[i + 2], g = params[i + 3], bl = params[i + 4];
          this.style[target] = `rgb(${r},${g},${bl})`;
          i += 5;
          continue;
        }
      }
      i++;
    }
  }
}

function applyStyle(el: HTMLElement, s: Style): void {
  if (s.fg) el.style.color = s.fg;
  if (s.bg) el.style.backgroundColor = s.bg;
  if (s.bold) el.style.fontWeight = "bold";
  if (s.italic) el.style.fontStyle = "italic";
  if (s.underline) el.style.textDecoration = "underline";
  if (s.dim) el.style.opacity = "0.7";
  if (s.inverse) {
    const fg = el.style.color || "var(--fg)";
    const bg = el.style.backgroundColor || "var(--bg)";
    el.style.color = bg;
    el.style.backgroundColor = fg;
  }
}

// Returns the number of trailing bytes that are part of an in-progress
// UTF-8 codepoint, so we can hold them over to the next feed.
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

// xterm 256-colour palette (compact).
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
  const step = (x: number) => x === 0 ? 0 : 55 + x * 40;
  return `rgb(${step(r)},${step(g)},${step(b)})`;
}
