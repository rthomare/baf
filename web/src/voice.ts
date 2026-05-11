// Voice input — Web Speech recognition shaped for terminal use.
//
// Output model: instead of one stream of bytes, the recognizer emits
// discrete events that the UI consumes:
//
//   interim → live transcript while the user is still speaking; the UI
//             shows this as a dim trailing hint, NOT in the draft.
//   final   → committed text; UI appends it to the draft buffer.
//   key     → a recognized control phrase (ctrl-c, esc, arrows, …) that
//             fires immediately, bypassing the draft.
//   command → a draft-level intent: execute (run), clear, newline,
//             backspace-word. The draft is owned by the UI, so commands
//             are routed to it.
//
// This split lets the draft feel like an editable buffer the user
// dictates into, while still keeping the "I just want to hit Esc" path
// fast and direct.

export type VoiceCommand = "execute" | "clear" | "newline" | "backspace-word";

export type VoiceEvent =
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string }
  | { kind: "key"; name: string }
  | { kind: "command"; cmd: VoiceCommand };

export interface VoiceController {
  toggle(): void;
  isActive(): boolean;
  on(handler: (ev: VoiceEvent) => void): void;
}

// Phrase that submits the current draft. Ordered: longer/more specific
// patterns first so the regex prefers them.
const COMMAND_PHRASES: [RegExp, VoiceCommand][] = [
  [/\b(send it|submit|send)\b/g, "execute"],
  [/\b(run it|execute|run|go ahead|go)\b/g, "execute"],
  [/\b(hit (?:enter|return)|press (?:enter|return)|enter|return)\b/g, "execute"],
  [/\b(scratch that|never ?mind|cancel that|clear that|clear)\b/g, "clear"],
  [/\b(new ?line)\b/g, "newline"],
  [/\b(delete that|backspace|delete the (?:last )?word)\b/g, "backspace-word"],
];

// Phrases that map to a named key. Resolved against KEYS by the consumer.
const KEY_PHRASES: [RegExp, string][] = [
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*c\b/g, "ctrl-c"],
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*d\b/g, "ctrl-d"],
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*l\b/g, "ctrl-l"],
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*r\b/g, "ctrl-r"],
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*z\b/g, "ctrl-z"],
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*u\b/g, "ctrl-u"],
  [/\b(control|ctrl)\s*(?:dash|hyphen)?\s*w\b/g, "ctrl-w"],
  [/\b(escape|esc)\b/g, "esc"],
  [/\btab\b/g, "tab"],
  [/\bspace\b/g, "space"],
  [/\b(up arrow|arrow up)\b/g, "up"],
  [/\b(down arrow|arrow down)\b/g, "down"],
  [/\b(left arrow|arrow left)\b/g, "left"],
  [/\b(right arrow|arrow right)\b/g, "right"],
];

// Word-level dev replacements applied to the residual text after key and
// command phrases are extracted.
const WORD_SUBS: [RegExp, string][] = [
  [/\bdot\b/g, "."],
  [/\bdash\b|\bhyphen\b|\bminus\b/g, "-"],
  [/\bslash\b/g, "/"],
  [/\bback ?slash\b/g, "\\"],
  [/\bpipe\b/g, "|"],
  [/\bcolon\b/g, ":"],
  [/\bsemicolon\b/g, ";"],
  [/\bequal(s)?\b/g, "="],
  [/\bunderscore\b/g, "_"],
  [/\bstar\b|\basterisk\b/g, "*"],
  [/\bhash\b|\bpound\b/g, "#"],
  [/\bat sign\b|\bat the rate\b/g, "@"],
  [/\bquote\b/g, '"'],
  [/\bopen paren\b/g, "("],
  [/\bclose paren\b/g, ")"],
  [/\bopen brace\b/g, "{"],
  [/\bclose brace\b/g, "}"],
  [/\bopen bracket\b/g, "["],
  [/\bclose bracket\b/g, "]"],
];

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  onend: (() => void) | null;
}

export function createVoice(): VoiceController | null {
  const Ctor =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!Ctor) return null;

  let active = false;
  let handler: ((ev: VoiceEvent) => void) | null = null;
  let recog: SpeechRecognitionLike | null = null;

  const emit = (ev: VoiceEvent) => handler?.(ev);

  const start = () => {
    recog = new Ctor() as SpeechRecognitionLike;
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = navigator.language || "en-US";
    recog.onresult = (ev: any) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const transcript: string = res[0].transcript;
        if (res.isFinal) {
          parseFinal(transcript, emit);
        } else {
          interim += transcript;
        }
      }
      if (interim) emit({ kind: "interim", text: interim.trim() });
    };
    recog.onerror = () => {
      // Permission denied, no-speech timeouts — exit quietly. The UI
      // will reset the voice toggle when isActive turns false.
      active = false;
    };
    recog.onend = () => {
      // Browsers stop recognition periodically; restart while the user
      // still wants us listening.
      if (active) {
        try {
          recog?.start();
        } catch {
          active = false;
        }
      }
    };
    try {
      recog.start();
    } catch {
      active = false;
    }
  };

  return {
    toggle() {
      active = !active;
      if (active) start();
      else recog?.stop();
    },
    isActive: () => active,
    on: (cb) => (handler = cb),
  };
}

// parseFinal extracts commands, keys, and residual text from a final
// transcript and emits them in source order. Linear pass over the
// transcript so spoken structure ("ls dash la enter") becomes the right
// sequence of events (text "ls -la", command "execute").
function parseFinal(raw: string, emit: (ev: VoiceEvent) => void) {
  const s = " " + raw.toLowerCase().trim() + " ";

  type Match =
    | { start: number; end: number; kind: "command"; payload: VoiceCommand }
    | { start: number; end: number; kind: "key"; payload: string };

  const matches: Match[] = [];
  for (const [pat, cmd] of COMMAND_PHRASES) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(s)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, kind: "command", payload: cmd });
    }
  }
  for (const [pat, key] of KEY_PHRASES) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(s)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, kind: "key", payload: key });
    }
  }
  matches.sort((a, b) => a.start - b.start);

  // De-overlap: keep the earliest match in each region.
  const kept: Match[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue;
    kept.push(m);
    cursor = m.end;
  }

  let pos = 0;
  for (const m of kept) {
    const seg = applyWordSubs(s.slice(pos, m.start));
    const text = seg.replace(/\s+/g, " ").trim();
    if (text) emit({ kind: "final", text });
    if (m.kind === "command") emit({ kind: "command", cmd: m.payload });
    else emit({ kind: "key", name: m.payload });
    pos = m.end;
  }
  const tail = applyWordSubs(s.slice(pos)).replace(/\s+/g, " ").trim();
  if (tail) emit({ kind: "final", text: tail });
}

function applyWordSubs(s: string): string {
  let out = s;
  for (const [pat, rep] of WORD_SUBS) {
    out = out.replace(pat, rep);
  }
  return out.replace(/[.,!?]+(\s|$)/g, "$1");
}
