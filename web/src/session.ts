// Session state: composer draft, history, voice indicator, current view
// mode. The reducer is pure; side-effectful actions (commit → send to
// PTY + persist history) are bound in useSession().

import { useReducer, useEffect, useMemo, useRef } from "react";
import { getTransport } from "./transport";
import { getBlockController } from "./block-controller-ref";

export type ViewMode = "block" | "raw";

export interface SessionState {
  draft: string;
  history: string[];
  historyCursor: number;
  recording: boolean;
  interim: string;
  // viewMode is what's *currently* on screen. userPreference is what the
  // user last chose via the toggle — TUI auto-flips force raw regardless,
  // but on the way out we restore the preference rather than always
  // landing back in block.
  viewMode: ViewMode;
  userPreference: ViewMode;
}

export type Action =
  | { type: "set-draft"; value: string }
  | { type: "append-draft"; text: string }
  | { type: "clear-draft" }
  | { type: "commit-accepted"; text: string }
  | { type: "history-step"; dir: -1 | 1 }
  | { type: "set-recording"; on: boolean }
  | { type: "set-interim"; text: string }
  | { type: "set-view-mode"; mode: ViewMode }
  | { type: "set-user-preference"; mode: ViewMode };

const HISTORY_KEY = "baf.history";

function readHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function writeHistory(history: string[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-500))); }
  catch { /* quota; ignore */ }
}

export function initialState(): SessionState {
  const history = readHistory();
  return {
    draft: "",
    history,
    historyCursor: history.length,
    recording: false,
    interim: "",
    // Default to raw: it covers Claude/Codex out of the box; block
    // transcript is opt-in.
    viewMode: "raw",
    userPreference: "raw",
  };
}

// Smart-space append: voice-driven appends should not collide with
// existing trailing text or punctuation.
function smartAppend(cur: string, s: string): string {
  if (!cur) return s;
  if (/\s$/.test(cur) || /^[ \t.,;:!?)\]}\n]/.test(s)) return cur + s;
  return cur + " " + s;
}

export function reduce(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "set-draft":
      return { ...state, draft: action.value };
    case "append-draft":
      return { ...state, draft: smartAppend(state.draft, action.text) };
    case "clear-draft":
      return { ...state, draft: "", interim: "" };
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
      };
    }
    case "history-step": {
      if (state.history.length === 0) return state;
      const next = Math.max(0, Math.min(state.history.length, state.historyCursor + action.dir));
      const draft = next === state.history.length ? "" : state.history[next];
      return { ...state, historyCursor: next, draft };
    }
    case "set-recording":
      return { ...state, recording: action.on };
    case "set-interim":
      return { ...state, interim: action.text };
    case "set-view-mode":
      if (action.mode === state.viewMode) return state;
      return { ...state, viewMode: action.mode };
    case "set-user-preference":
      return { ...state, userPreference: action.mode, viewMode: action.mode };
  }
}

export interface SessionActions {
  setDraft(value: string): void;
  appendDraft(text: string): void;
  clearDraft(): void;
  commitDraft(): void;
  historyStep(dir: -1 | 1): void;
  setRecording(on: boolean): void;
  setInterim(text: string): void;
  setViewMode(mode: ViewMode): void;
  setUserPreference(mode: ViewMode): void;
}

const enc = new TextEncoder();

export function useSession() {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);

  // Persist history whenever it changes. Synchronous; ~tiny.
  const lastPersisted = useRef(state.history);
  useEffect(() => {
    if (lastPersisted.current !== state.history) {
      writeHistory(state.history);
      lastPersisted.current = state.history;
    }
  }, [state.history]);

  // Keep a ref to draft so action helpers can read its current value
  // without forcing themselves to be re-bound on every keystroke.
  const draftRef = useRef(state.draft);
  draftRef.current = state.draft;

  const actions = useMemo<SessionActions>(() => ({
    setDraft(value) { dispatch({ type: "set-draft", value }); },
    appendDraft(text) { dispatch({ type: "append-draft", text }); },
    clearDraft() { dispatch({ type: "clear-draft" }); },
    commitDraft() {
      const text = draftRef.current;
      const transport = getTransport();
      if (text) {
        getBlockController()?.noteSentCommand(text);
        transport.send(enc.encode(text));
      }
      transport.send(enc.encode("\r"));
      dispatch({ type: "commit-accepted", text });
    },
    historyStep(dir) { dispatch({ type: "history-step", dir }); },
    setRecording(on) { dispatch({ type: "set-recording", on }); },
    setInterim(text) { dispatch({ type: "set-interim", text }); },
    setViewMode(mode) { dispatch({ type: "set-view-mode", mode }); },
    setUserPreference(mode) { dispatch({ type: "set-user-preference", mode }); },
  }), []);

  return { state, actions };
}
