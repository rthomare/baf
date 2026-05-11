import { useEffect, useRef } from "react";
import { pressKey } from "../actions";
import { useTransport } from "../useTransport";
import { useSessionActions, useSessionState } from "../SessionContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

const KEYS: Array<{ key: string; label: string }> = [
  { key: "ctrl-d", label: "Ctrl-D" },
  { key: "ctrl-l", label: "Ctrl-L" },
  { key: "ctrl-z", label: "Ctrl-Z" },
  { key: "ctrl-r", label: "Ctrl-R" },
  { key: "ctrl-u", label: "Ctrl-U" },
  { key: "ctrl-w", label: "Ctrl-W" },
  { key: "home", label: "Home" },
  { key: "end", label: "End" },
  { key: "pageup", label: "PgUp" },
  { key: "pagedown", label: "PgDn" },
];

export function Overflow({ open, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { leave } = useTransport();
  const { viewMode } = useSessionState();
  const actions = useSessionActions();
  const isRaw = viewMode === "raw";
  const viewLabel = isRaw ? "blocks" : "raw";
  const viewTarget = isRaw ? "block" : "raw";

  // Click anywhere outside the panel (and outside the more-toggle that
  // opens it) closes it. The more-toggle's own click is allowed through
  // so it can drive the open/close itself.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (ref.current?.contains(t)) return;
      const more = document.getElementById("more-toggle");
      if (more?.contains(t)) return;
      onClose();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open, onClose]);

  const onClick = (key: string) => {
    pressKey(key);
    onClose();
  };

  return (
    <div id="overflow" ref={ref} hidden={!open} role="menu">
      <div className="overflow-actions">
        <button
          id="view-toggle"
          type="button"
          aria-label="toggle terminal view"
          data-active={isRaw ? "raw" : "block"}
          onClick={() => {
            actions.setUserPreference(viewTarget);
            onClose();
          }}
        >
          {viewLabel}
        </button>
        <button
          id="leave"
          type="button"
          aria-label="disconnect from this session"
          onClick={() => {
            onClose();
            leave();
          }}
        >
          leave
        </button>
      </div>
      <div className="overflow-keys">
        {KEYS.map(({ key, label }) => (
          <button key={key} data-key={key} onClick={() => onClick(key)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
