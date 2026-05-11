// Bridges the imperative voice controller to session actions. Voice
// events arrive as interim text, final text, named keys, or commands;
// we translate each into the corresponding session mutation.

import { useEffect, useRef } from "react";
import { getVoice } from "./voice-singleton";
import { useSessionActions, useSessionState } from "./SessionContext";
import { pressKey } from "./actions";
import type { VoiceCommand, VoiceEvent } from "./voice";

export function useVoice(): void {
  const actions = useSessionActions();
  const draft = useSessionState().draft;

  // Keep a ref so the subscription only binds once per mount instead of
  // re-binding on every keystroke.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const v = getVoice();
    if (!v) return;

    const handleCommand = (cmd: VoiceCommand) => {
      switch (cmd) {
        case "execute":
          actions.commitDraft();
          break;
        case "clear":
          actions.clearDraft();
          break;
        case "newline":
          actions.appendDraft("\n");
          break;
        case "backspace-word":
          actions.setDraft(draftRef.current.replace(/\s+\S*\s*$/, ""));
          break;
      }
    };

    v.on((ev: VoiceEvent) => {
      switch (ev.kind) {
        case "interim":
          actions.setInterim(ev.text);
          break;
        case "final":
          actions.setInterim("");
          actions.appendDraft(ev.text);
          break;
        case "key":
          pressKey(ev.name);
          break;
        case "command":
          handleCommand(ev.cmd);
          break;
      }
    });
  }, [actions]);
}
