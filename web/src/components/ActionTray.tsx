import { useEffect, useRef, useState } from "react";
import { useSessionActions, useSessionState } from "../SessionContext";
import { useJoystick, type Dir } from "../useJoystick";
import { getVoice } from "../voice-singleton";
import { pressKey } from "../actions";
import { Waveform } from "./Waveform";

// One panel: gradient pane with a textarea on the left and a single
// circular mic/send button on the right that doubles as the joystick.
// Soft keys (ctrl-c / esc / tab / …) sit at the bottom of the textarea
// pane. When the composer has text, the keys collapse and an
// `actions` chip + close `x` take over; tapping `actions` brings the
// keys back so they're still reachable mid-draft.

interface Props {
  onToggleOverflow: () => void;
  overflowOpen: boolean;
}

export function ActionTray({ onToggleOverflow, overflowOpen }: Props) {
  const { draft, interim, recording, historyCursor, history } = useSessionState();
  const actions = useSessionActions();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [keysExpanded, setKeysExpanded] = useState(false);
  const hasText = draft.trim().length > 0;
  const showKeys = !hasText || keysExpanded;

  // Auto-grow the textarea up to a cap. The pane keeps a stable height,
  // so the textarea grows inside it without pushing layout. While
  // recording the pane lifts into a 50vh overlay and the textarea
  // fills it via CSS, so we hand height back to the stylesheet.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    if (recording) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [draft, recording]);

  // After history scrub, push the caret to end.
  useEffect(() => {
    const el = taRef.current;
    if (!el || document.activeElement !== el) return;
    el.setSelectionRange(el.value.length, el.value.length);
  }, [historyCursor]);

  // Collapse the keys whenever the draft becomes empty so the next
  // empty-state shows them again without a stale expanded flag.
  useEffect(() => {
    if (!hasText) setKeysExpanded(false);
  }, [hasText]);

  // Joystick: all 4 arrows go to the PTY.
  const fireDir = (dir: Dir) => {
    pressKey(dir);
  };

  const { state, knobRef, rootProps } = useJoystick({
    onTap: () => actions.commitDraft(),
    onDragFire: fireDir,
    onHoldStart: () => {
      const v = getVoice();
      if (!v) return;
      actions.setRecording(true);
      v.toggle();
    },
    onHoldEnd: () => {
      const v = getVoice();
      if (v?.isActive()) v.toggle();
      actions.setRecording(false);
      actions.setInterim("");
    },
  });

  // iOS Safari consumes the first tap on a focusable element outside an
  // open soft keyboard to dismiss the keyboard — so the joystick's
  // pointerdown never fires until tap #2. Pre-blurring the composer
  // here makes the dismissal our action, not the system's, so the very
  // first tap reaches the joystick.
  const onJoystickPointerDown = (e: React.PointerEvent) => {
    const ta = taRef.current;
    if (ta && document.activeElement === ta) ta.blur();
    rootProps.onPointerDown(e);
  };

  const onKeyChip = (k: string) => {
    pressKey(k);
    if (keysExpanded) setKeysExpanded(false);
  };

  return (
    <div className="action-tray" data-recording={recording}>
      <div className="action-pane">
        <textarea
          ref={taRef}
          id="composer"
          className="action-textarea"
          rows={2}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder={recording ? "" : "Start typing, joystick, or hold down to record."}
          aria-label="command draft"
          value={draft}
          data-recording={recording}
          onChange={(e) => actions.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              actions.commitDraft();
              return;
            }
            const el = e.currentTarget;
            if (
              e.key === "ArrowUp" &&
              history.length > 0 &&
              el.selectionStart === 0 &&
              el.selectionEnd === 0
            ) {
              e.preventDefault();
              actions.historyStep(-1);
            } else if (
              e.key === "ArrowDown" &&
              historyCursor < history.length &&
              el.selectionStart === el.value.length
            ) {
              e.preventDefault();
              actions.historyStep(1);
            }
          }}
        />

        <Waveform active={recording} />

        <div className="action-interim" aria-live="polite">{interim}</div>

        <div className={`action-keys${showKeys ? "" : " hidden"}`} role="toolbar" aria-label="terminal shortcuts">
          <button
            type="button"
            className="action-chip"
            data-key="ctrl-c"
            onClick={() => onKeyChip("ctrl-c")}
            tabIndex={showKeys ? 0 : -1}
          >
            ctrl-c
          </button>
          <button
            type="button"
            className="action-chip"
            data-key="esc"
            onClick={() => onKeyChip("esc")}
            tabIndex={showKeys ? 0 : -1}
          >
            esc
          </button>
          <button
            type="button"
            className="action-chip"
            data-key="tab"
            onClick={() => onKeyChip("tab")}
            tabIndex={showKeys ? 0 : -1}
          >
            tab
          </button>
          <button
            id="more-toggle"
            type="button"
            className="action-chip"
            data-key="more"
            aria-expanded={overflowOpen}
            aria-label="more keys"
            onClick={onToggleOverflow}
            tabIndex={showKeys ? 0 : -1}
          >
            …
          </button>
        </div>

        <button
          type="button"
          className={`action-actions${hasText && !keysExpanded ? "" : " hidden"}`}
          aria-label="show shortcut keys"
          onClick={() => setKeysExpanded(true)}
          tabIndex={hasText && !keysExpanded ? 0 : -1}
        >
          actions
        </button>

        <button
          type="button"
          className={`action-close${hasText ? "" : " hidden"}`}
          aria-label="clear draft"
          onClick={() => actions.clearDraft()}
          tabIndex={hasText ? 0 : -1}
        >
          ×
        </button>
      </div>

      <div className="joystick-rail">
        <div
          className="joystick-ring"
          data-recording={recording}
          data-state={state}
          role="button"
          tabIndex={0}
          aria-label={
            hasText
              ? "send command"
              : "tap to submit, drag for arrows, hold for voice"
          }
          {...rootProps}
          onPointerDown={onJoystickPointerDown}
        >
          <div className="joystick-base" aria-hidden="true" />
          <div className="joystick-knob" ref={knobRef} data-recording={recording}>
            <div className="joystick-button">
              {hasText ? <SendGlyph /> : <MicGlyph />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MicGlyph() {
  return (
    <svg className="joystick-icon" viewBox="0 0 25 25" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M9.375 5.469c0-2.158 1.749-3.907 3.906-3.907s3.907 1.749 3.907 3.907v7.812c0 2.158-1.75 3.907-3.907 3.907s-3.906-1.749-3.906-3.907V5.469Zm3.906 13.281c3.02 0 5.469-2.448 5.469-5.469V5.469c0-3.02-2.449-5.469-5.469-5.469s-5.469 2.448-5.469 5.469v7.812c0 3.021 2.449 5.469 5.469 5.469Zm8.594-3.906h-1.563c-.712 3.13-3.686 5.468-7.031 5.468-3.346 0-6.32-2.338-7.032-5.468H4.688c.69 3.749 3.955 6.648 7.812 6.996v1.598h-.78a.78.78 0 1 0 0 1.562h3.124a.78.78 0 0 0 0-1.562h-.781v-1.598c3.857-.348 7.122-3.247 7.812-6.996Z"
      />
    </svg>
  );
}

function SendGlyph() {
  return (
    <svg className="joystick-icon" viewBox="0 0 15 20" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M6.91 0.25a.83.83 0 0 1 1.18 0L14.76 7.11a.83.83 0 0 1-1.18 1.21L8.33 2.93v16.21a.83.83 0 0 1-1.67 0V2.93L1.42 8.32A.83.83 0 1 1 0.24 7.11L6.91 0.25Z"
      />
    </svg>
  );
}
