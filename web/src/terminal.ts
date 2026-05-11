// xterm.js for raw mode. Only mounted on demand — when an alt-screen
// sequence flips the client out of the block transcript and a full
// emulator is needed (vim, htop, less, fzf, etc.). Geometry comes from
// the host (PTY size), font is auto-sized to fit the viewport.

import { Terminal } from "@xterm/xterm";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 18;
const LINE_HEIGHT = 1.15;
const CELL_WIDTH_RATIO = 0.6;

export interface Term {
  term: Terminal;
  attach: (host: HTMLElement) => void;
  setGeometry: (cols: number, rows: number) => void;
  onData: (cb: (s: string) => void) => void;
  write: (data: Uint8Array | string) => void;
  focus: () => void;
}

export function createTerm(): Term {
  const term = new Terminal({
    cursorBlink: false,
    convertEol: false,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: DEFAULT_FONT_SIZE,
    lineHeight: LINE_HEIGHT,
    letterSpacing: 0,
    allowProposedApi: true,
    scrollback: 1000,
    theme: {
      background: "#0b0b0b",
      foreground: "#d7d7d7",
      cursor: "#8ec07c",
      cursorAccent: "#0b0b0b",
      selectionBackground: "#3a3a3a",
      black: "#0b0b0b",
      red: "#e06c75",
      green: "#8ec07c",
      yellow: "#e5c07b",
      blue: "#7aa6da",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#d7d7d7",
      brightBlack: "#5c5c5c",
      brightRed: "#ef8a92",
      brightGreen: "#a8d49a",
      brightYellow: "#f0d28a",
      brightBlue: "#9bbef0",
      brightMagenta: "#dba6ef",
      brightCyan: "#7fd0d8",
      brightWhite: "#ffffff",
    },
  });
  term.loadAddon(new WebLinksAddon());

  let mounted: HTMLElement | null = null;

  return {
    term,
    attach: (host) => {
      if (mounted === host) return;
      term.open(host);
      mounted = host;
      // WebGL renderer: must load after open() (it needs the host's
      // canvas context). Falls back to the default DOM renderer if the
      // context is lost or unavailable.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* no WebGL → stay on the DOM renderer */
      }
    },
    setGeometry: (cols, rows) => {
      if (!mounted) return;
      const rect = mounted.getBoundingClientRect();
      const maxByWidth = rect.width / cols / CELL_WIDTH_RATIO;
      const maxByHeight = rect.height / rows / LINE_HEIGHT;
      const target = Math.min(maxByWidth, maxByHeight);
      const next = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(target)));
      if (term.options.fontSize !== next) term.options.fontSize = next;
      try { term.resize(cols, rows); } catch { /* ignore */ }
    },
    onData: (cb) => term.onData(cb),
    write: (data) => term.write(data as any),
    focus: () => term.focus(),
  };
}
