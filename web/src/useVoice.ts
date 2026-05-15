// Bridges the imperative voice controller to session actions.
//
// Transcripts ("final" events) feed `pendingVoice` rather than the live
// draft so an autocorrect or misheard fragment can't accidentally type
// itself into the running shell. The user confirms (or discards) the
// pending text via the action pane.
//
// "key" events still fire immediately — they encode intent ("ctrl-c"
// means stop the program *now*), not text. "command" phrases prefer
// the pending transcript when there's one outstanding; otherwise they
// operate on the live draft (with the usual PTY side effects).

import { useEffect, useRef } from "react";
import { getVoice } from "./voice-singleton";
import { useSessionActions, useSessionState } from "./SessionContext";
import type { VoiceCommand, VoiceEvent } from "./voice";

export function useVoice(): void {
  const actions = useSessionActions();
  const { draft, pendingVoice } = useSessionState();

  // Keep refs so the subscription only binds once per mount.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pendingRef = useRef(pendingVoice);
  pendingRef.current = pendingVoice;

  useEffect(() => {
    const v = getVoice();
    if (!v) return;

    const handleCommand = (cmd: VoiceCommand) => {
      switch (cmd) {
        case "execute":
          // Confirm anything pending first, then submit the line. The
          // confirm streams the chars; the commit just sends CR.
          if (pendingRef.current) actions.confirmPendingVoice();
          actions.commitDraft();
          break;
        case "clear":
          // If there's a pending transcript, the natural meaning of
          // "scratch that" is to discard the pending — the running
          // shell line hasn't been touched yet. Otherwise wipe the
          // live draft (which also clears the shell line via DEL).
          if (pendingRef.current) actions.discardPendingVoice();
          else actions.clearDraft();
          break;
        case "newline":
          if (pendingRef.current) actions.appendPendingVoice("\n");
          else actions.appendDraft("\n");
          break;
        case "backspace-word":
          if (pendingRef.current) {
            // Trim a trailing word from pending — purely local.
            const stripped = pendingRef.current.replace(/\s+\S*\s*$/, "");
            // Direct dispatch via set-pending: appendPendingVoice
            // doesn't support shrinking. Replace by calling confirm/
            // discard isn't right either, so go through the action.
            actions.discardPendingVoice();
            if (stripped) actions.appendPendingVoice(stripped);
          } else {
            actions.setDraft(draftRef.current.replace(/\s+\S*\s*$/, ""));
          }
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
          actions.appendPendingVoice(ev.text);
          break;
        case "key":
          actions.pressKey(ev.name);
          break;
        case "command":
          handleCommand(ev.cmd);
          break;
      }
    });
  }, [actions]);
}
