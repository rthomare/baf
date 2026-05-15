// Session state.
//
// The mobile composer is the only typing surface: every change to
// `draft` is diffed against the previous value and the delta is shipped
// live to the PTY (DEL bytes for deletions, the inserted text for
// insertions). The shell echoes those bytes at the cursor, so what's in
// the composer matches what's on the shell's current command line on
// the happy path.
//
// When a non-composer keystroke fires (overflow Ctrl-U, joystick
// arrows, a project command, etc.) the shell line is altered out from
// under us. The action that fires those bytes also calls
// `stashAndClearDraft`, which moves the current draft into
// `stashedDraft` and empties the visible draft. A small Restore chip in
// the action pane then lets the user re-stream those bytes.
//
// Voice is gated by an explicit confirm step: dictated text accrues in
// `pendingVoice` (not `draft`) until the user taps Confirm, at which
// point it's appended to the draft and live-streamed to the PTY. This
// prevents an autocorrect or misheard fragment from typing itself into
// the running shell.

import { useReducer, useEffect, useMemo, useRef } from "react";
import { getTransport } from "./transport";
import { keyToBytes } from "./keys";
import type { Project } from "./ws";

export interface SessionState {
  draft: string;
  history: string[];
  historyCursor: number;
  recording: boolean;
  interim: string;
  // Discovered .baf/config.toml(s); null when baf was started outside
  // any project tree.
  project: Project | null;
  // Voice transcript awaiting user confirmation. Distinct from `draft`
  // so the running shell never sees dictated text until the user OKs
  // it. Empty string = nothing pending.
  pendingVoice: string;
  // Last draft that was wiped by a side effect (overflow key, joystick
  // arrow, project command). Null when there's nothing to restore.
  stashedDraft: string | null;
}

export type Action =
  | { type: "set-draft"; value: string }
  | { type: "clear-draft" }
  | { type: "commit-accepted"; text: string }
  | { type: "history-step"; dir: -1 | 1 }
  | { type: "set-recording"; on: boolean }
  | { type: "set-interim"; text: string }
  | { type: "set-project"; project: Project | null }
  | { type: "set-pending-voice"; text: string }
  | { type: "stash-and-clear" }
  | { type: "clear-stashed" };

const HISTORY_KEY = "baf.history";

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

function writeHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-500)));
  } catch {
    /* quota; ignore */
  }
}

export function initialState(): SessionState {
  const history = readHistory();
  return {
    draft: "",
    history,
    historyCursor: history.length,
    recording: false,
    interim: "",
    project: null,
    pendingVoice: "",
    stashedDraft: null,
  };
}

// Smart-space append: voice-driven appends shouldn't smash up against
// trailing text or punctuation.
function smartAppend(cur: string, s: string): string {
  if (!cur) return s;
  if (/\s$/.test(cur) || /^[ \t.,;:!?)\]}\n]/.test(s)) return cur + s;
  return cur + " " + s;
}

function historyDraftAt(state: SessionState, dir: -1 | 1): {
  next: number;
  draft: string;
} {
  const next = Math.max(
    0,
    Math.min(state.history.length, state.historyCursor + dir),
  );
  const draft = next === state.history.length ? "" : state.history[next];
  return { next, draft };
}

export function reduce(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "set-draft":
      return { ...state, draft: action.value };
    case "clear-draft":
      return { ...state, draft: "" };
    case "commit-accepted": {
      const trimmed = action.text;
      if (!trimmed) return { ...state, draft: "", interim: "" };
      const history = [...state.history, trimmed];
      return {
        ...state,
        draft: "",
        interim: "",
        history,
        historyCursor: history.length,
        // A committed line means the previous stash is no longer meaningful.
        stashedDraft: null,
      };
    }
    case "history-step": {
      if (state.history.length === 0) return state;
      const { next, draft } = historyDraftAt(state, action.dir);
      return { ...state, historyCursor: next, draft };
    }
    case "set-recording":
      return { ...state, recording: action.on };
    case "set-interim":
      return { ...state, interim: action.text };
    case "set-project":
      return { ...state, project: action.project };
    case "set-pending-voice":
      return { ...state, pendingVoice: action.text };
    case "stash-and-clear":
      if (state.draft === "") return state;
      return { ...state, draft: "", stashedDraft: state.draft };
    case "clear-stashed":
      if (state.stashedDraft === null) return state;
      return { ...state, stashedDraft: null };
  }
}

export interface SessionActions {
  // Textarea binding. Diffs against the previous draft and live-streams
  // the delta (DEL for deletions, the inserted text for insertions) to
  // the PTY. Also drops any pending Restore stash — the user is engaging.
  setDraft(value: string): void;
  // Programmatic append (used by confirm-voice and command helpers).
  // Smart-spaces, then streams only the inserted bytes.
  appendDraft(text: string): void;
  // Wipe the draft locally AND send the matching DEL bytes so the
  // shell line is wiped too. Used by the voice "clear" command when
  // there's no pending voice to discard.
  clearDraft(): void;
  // Submit the current line. Chars already streamed live, so this just
  // ships a single CR and pushes the text into history.
  commitDraft(): void;
  // Scrub composer-local history (not shell history). Streams the diff
  // so the shell's line updates to match.
  historyStep(dir: -1 | 1): void;
  setRecording(on: boolean): void;
  setInterim(text: string): void;
  setProject(project: Project | null): void;
  // Project command — types `run + \r` at the cursor. Stashes any
  // current draft first so the user can restore it.
  runProjectCommand(run: string): void;
  // Send a named key (ctrl-c, esc, arrow, etc.) directly to the PTY.
  // Stashes any current draft first because the keystroke is about to
  // mutate the shell line behind the composer's back.
  pressKey(name: string): void;
  // Restore the most-recently-stashed draft. Re-streams the bytes to
  // the PTY so they reappear at the current cursor.
  restoreDraft(): void;
  // Voice — accumulate, confirm, or discard a transcript.
  appendPendingVoice(text: string): void;
  confirmPendingVoice(): void;
  discardPendingVoice(): void;
}

const enc = new TextEncoder();
const DEL = "\x7f";

// shipDelta — find the common prefix between two strings, then send
// `dels` DEL bytes followed by the inserted suffix. This is enough for
// all linear edits the textarea produces (typing, deleting from the
// end, mid-string insertion, mid-string deletion, paste, autocorrect
// replacement). The shell receives a sequence equivalent to typing the
// result text from the common prefix forward.
function shipDelta(oldVal: string, newVal: string): void {
  if (oldVal === newVal) return;
  let i = 0;
  const maxPrefix = Math.min(oldVal.length, newVal.length);
  while (i < maxPrefix && oldVal.charCodeAt(i) === newVal.charCodeAt(i)) i++;
  const dels = oldVal.length - i;
  const inserts = newVal.slice(i);
  const transport = getTransport();
  if (dels > 0) transport.send(enc.encode(DEL.repeat(dels)));
  if (inserts.length > 0) transport.send(enc.encode(inserts));
}

export function useSession() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);

  // Persist history whenever it changes.
  const lastPersisted = useRef(state.history);
  useEffect(() => {
    if (lastPersisted.current !== state.history) {
      writeHistory(state.history);
      lastPersisted.current = state.history;
    }
  }, [state.history]);

  // Refs let the memoized actions read current state without rebinding
  // on every keystroke.
  const stateRef = useRef(state);
  stateRef.current = state;

  const actions = useMemo<SessionActions>(() => {
    const streamSetDraft = (value: string) => {
      const cur = stateRef.current.draft;
      shipDelta(cur, value);
      dispatch({ type: "set-draft", value });
      if (stateRef.current.stashedDraft !== null) {
        dispatch({ type: "clear-stashed" });
      }
    };

    return {
      setDraft: streamSetDraft,
      appendDraft(text) {
        const cur = stateRef.current.draft;
        const next = smartAppend(cur, text);
        streamSetDraft(next);
      },
      clearDraft() {
        const cur = stateRef.current.draft;
        if (cur.length > 0) {
          getTransport().send(enc.encode(DEL.repeat(cur.length)));
        }
        dispatch({ type: "clear-draft" });
        if (stateRef.current.stashedDraft !== null) {
          dispatch({ type: "clear-stashed" });
        }
      },
      commitDraft() {
        const text = stateRef.current.draft;
        // Chars already went live; just ship the carriage return.
        getTransport().send(enc.encode("\r"));
        dispatch({ type: "commit-accepted", text });
      },
      historyStep(dir) {
        const s = stateRef.current;
        if (s.history.length === 0) return;
        const { next, draft } = historyDraftAt(s, dir);
        if (next === s.historyCursor) return;
        shipDelta(s.draft, draft);
        dispatch({ type: "history-step", dir });
        if (stateRef.current.stashedDraft !== null) {
          dispatch({ type: "clear-stashed" });
        }
      },
      setRecording(on) {
        dispatch({ type: "set-recording", on });
      },
      setInterim(text) {
        dispatch({ type: "set-interim", text });
      },
      setProject(project) {
        dispatch({ type: "set-project", project });
      },
      runProjectCommand(run) {
        // About to overwrite the shell's line with a new command — give
        // the user a chance to come back.
        dispatch({ type: "stash-and-clear" });
        const t = getTransport();
        if (run) t.send(enc.encode(run));
        t.send(enc.encode("\r"));
      },
      pressKey(name) {
        const bytes = keyToBytes(name);
        if (!bytes) return;
        // Any external keystroke can mutate the shell line in ways the
        // composer can't follow (Ctrl-U, Ctrl-R, arrows, …) — stash
        // before firing so the chip appears.
        dispatch({ type: "stash-and-clear" });
        getTransport().send(enc.encode(bytes));
      },
      restoreDraft() {
        const stash = stateRef.current.stashedDraft;
        if (stash == null || stash === "") return;
        // Stream the chars at the current cursor; whatever was just on
        // the shell line stays in place, the stash text gets appended.
        getTransport().send(enc.encode(stash));
        dispatch({ type: "set-draft", value: stash });
        dispatch({ type: "clear-stashed" });
      },
      appendPendingVoice(text) {
        const cur = stateRef.current.pendingVoice;
        dispatch({ type: "set-pending-voice", text: smartAppend(cur, text) });
      },
      confirmPendingVoice() {
        const text = stateRef.current.pendingVoice;
        if (!text) return;
        const curDraft = stateRef.current.draft;
        const next = smartAppend(curDraft, text);
        streamSetDraft(next);
        dispatch({ type: "set-pending-voice", text: "" });
      },
      discardPendingVoice() {
        if (stateRef.current.pendingVoice !== "") {
          dispatch({ type: "set-pending-voice", text: "" });
        }
      },
    };
  }, []);

  return { state, actions };
}
