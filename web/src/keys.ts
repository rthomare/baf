// Named keys → raw byte sequences sent to the PTY.
//
// Why: HTML attributes can't carry bare control bytes cleanly, and we want
// a small named vocabulary that voice and tray can both reuse.

export const KEYS: Record<string, string> = {
  "ctrl-a": "\x01",
  "ctrl-b": "\x02",
  "ctrl-c": "\x03",
  "ctrl-d": "\x04",
  "ctrl-e": "\x05",
  "ctrl-f": "\x06",
  "ctrl-g": "\x07",
  "ctrl-h": "\x08",
  "ctrl-k": "\x0b",
  "ctrl-l": "\x0c",
  "ctrl-n": "\x0e",
  "ctrl-p": "\x10",
  "ctrl-r": "\x12",
  "ctrl-u": "\x15",
  "ctrl-w": "\x17",
  "ctrl-z": "\x1a",
  esc: "\x1b",
  tab: "\t",
  enter: "\r",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  space: " ",
};

export function keyToBytes(name: string): string | null {
  return KEYS[name] ?? null;
}
