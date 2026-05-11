// Subscribes to PTY bytes coming off the transport and routes them
// through the parser into:
//   - xterm.write for every byte chunk
//   - the block transcript for prompt-start/output-start/command-end
//   - session view-mode flips for alt-screen / cursor visibility
//
// Lives at the top of the React tree (App) so it boots once.

import { useEffect, useRef } from "react";
import { getTransport } from "./transport";
import { getXterm } from "./xterm-singleton";
import { getBlockController } from "./block-controller-ref";
import { StreamParser } from "./parser";
import { useSessionActions, useSessionState } from "./SessionContext";

export function useStreamRouter(): void {
  const actions = useSessionActions();
  const { viewMode, userPreference } = useSessionState();

  // Refs hold latest viewMode/userPreference so the subscription
  // doesn't re-bind on every change.
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const userPrefRef = useRef(userPreference);
  userPrefRef.current = userPreference;

  useEffect(() => {
    const t = getTransport();
    const xt = getXterm();
    const parser = new StreamParser();

    return t.onOutput((chunk) => {
      parser.feed(chunk, (ev) => {
        if (ev.type === "alt-screen") {
          // Alt-screen on always forces raw. Off restores user preference,
          // so a user who explicitly chose block doesn't get stuck in raw
          // after vim exits — and a user on the default (raw) stays raw.
          actions.setViewMode(ev.on ? "raw" : userPrefRef.current);
          return;
        }
        if (ev.type === "cursor") {
          // Hide-cursor forces raw (Claude/Codex/Ink inline TUIs). Show-
          // cursor isn't reliable as an exit signal; command-end handles it.
          if (!ev.visible && viewModeRef.current === "block") actions.setViewMode("raw");
          return;
        }
        const controller = getBlockController();
        if (ev.type === "command-end") {
          if (viewModeRef.current === "raw") actions.setViewMode(userPrefRef.current);
          controller?.handle(ev);
          return;
        }
        if (ev.type === "bytes") {
          xt.write(ev.data);
          if (viewModeRef.current === "block") controller?.handle(ev);
          return;
        }
        controller?.handle(ev);
      });
    });
  }, [actions]);
}
