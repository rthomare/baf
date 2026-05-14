import { useEffect, useRef } from "react";
import { pressKey } from "../actions";
import { useTransport } from "../useTransport";
import { useSessionActions, useSessionState } from "../SessionContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

const KEYS: Array<{ key: string; label: string }> = [
  { key: "ctrl-c", label: "ctrl-c" },
  { key: "esc", label: "esc" },
  { key: "tab", label: "tab" },
  { key: "ctrl-d", label: "ctrl-d" },
  { key: "ctrl-l", label: "ctrl-l" },
  { key: "ctrl-z", label: "ctrl-z" },
  { key: "ctrl-r", label: "ctrl-r" },
  { key: "ctrl-u", label: "ctrl-u" },
  { key: "ctrl-w", label: "ctrl-w" },
  { key: "home", label: "home" },
  { key: "end", label: "end" },
  { key: "pageup", label: "pgup" },
  { key: "pagedown", label: "pgdn" },
];

export function Overflow({ open, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { leave } = useTransport();
  const { project } = useSessionState();
  const sessionActions = useSessionActions();

  // Click anywhere outside the panel (and outside the settings button
  // that opens it) closes it. The settings button's own click is
  // allowed through so it can drive the open/close itself.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (ref.current?.contains(t)) return;
      const settings = document.getElementById("settings-toggle");
      if (settings?.contains(t)) return;
      onClose();
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open, onClose]);

  const onClick = (key: string) => {
    pressKey(key);
    onClose();
  };

  const onCommand = (run: string) => {
    sessionActions.runProjectCommand(run);
    onClose();
  };

  return (
    <div
      id="overflow"
      ref={ref}
      data-open={open}
      role="menu"
      aria-hidden={!open}
    >
      {project && project.commands.length > 0 && (
        <section className="overflow-project" aria-label="project commands">
          <header className="overflow-section-header">
            <span className="overflow-section-title">{project.name}</span>
          </header>
          <ul className="overflow-commands">
            {project.commands.map((cmd) => (
              <li key={cmd.id}>
                <button
                  type="button"
                  className="overflow-command"
                  tabIndex={open ? 0 : -1}
                  onClick={() => onCommand(cmd.run)}
                >
                  <span className="overflow-command-name">{cmd.name}</span>
                  <span className="overflow-command-run">
                    {cmd.description ?? cmd.run}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="overflow-keys">
        {KEYS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            data-key={key}
            tabIndex={open ? 0 : -1}
            onClick={() => onClick(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="overflow-actions">
        <span className="overflow-hint" aria-hidden="true">
          shortcuts
        </span>
        <button
          id="leave"
          type="button"
          aria-label="disconnect from this session"
          tabIndex={open ? 0 : -1}
          onClick={() => {
            onClose();
            leave();
          }}
        >
          leave
        </button>
      </div>
    </div>
  );
}
