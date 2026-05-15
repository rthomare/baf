import { useEffect, useMemo, useRef, useState } from "react";
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

// Threshold above which we surface a filter input. Single-source projects
// with a handful of commands shouldn't see UI chrome they don't need;
// anything denser than this benefits from search.
const FILTER_THRESHOLD = 8;

export function Overflow({ open, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { leave } = useTransport();
  const { project } = useSessionState();
  const sessionActions = useSessionActions();
  const [filter, setFilter] = useState("");

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

  // Reset the filter every time the panel closes so reopening starts
  // from a clean state.
  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  const sources = project?.sources ?? [];
  const totalCommands = useMemo(
    () => sources.reduce((n, s) => n + s.commands.length, 0),
    [sources],
  );

  // Filter sections by command name (and `run` as a fallback) so the
  // user can type a fragment of what they remember. Sections whose
  // matched list is empty are hidden — better to disappear than to
  // render lonely headers.
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sources;
    return sources
      .map((s) => ({
        ...s,
        commands: s.commands.filter(
          (c) =>
            c.name.toLowerCase().includes(q) || c.run.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.commands.length > 0);
  }, [sources, filter]);

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
      {totalCommands > 0 && (
        <div className="overflow-project">
          {totalCommands > FILTER_THRESHOLD && (
            <div className="overflow-project-filter">
              <input
                type="search"
                inputMode="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="filter commands"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                tabIndex={open ? 0 : -1}
                aria-label="filter project commands"
              />
            </div>
          )}
          {filtered.map((src) => (
            <section
              key={src.root}
              className="overflow-project-section"
              aria-label={`commands from ${src.name}`}
            >
              <header className="overflow-section-header">
                <span className="overflow-section-title">{src.name}</span>
              </header>
              <ul className="overflow-commands">
                {src.commands.map((cmd) => (
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
          ))}
        </div>
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
          color="red"
          type="button"
          aria-label="disconnect from this session"
          tabIndex={open ? 0 : -1}
          onClick={() => {
            onClose();
            leave();
          }}
        >
          disconnect
        </button>
      </div>
    </div>
  );
}
