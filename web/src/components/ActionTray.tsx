import { useEffect, useRef } from "react";
import { useSessionActions, useSessionState } from "../SessionContext";
import { useJoystick, type Dir } from "../useJoystick";
import { getVoice } from "../voice-singleton";
import { Waveform } from "./Waveform";

// One horizontal row: content pane on the left, joystick on the right.
// The pane holds the textarea normally; while recording, the textarea
// hides and the waveform canvas takes the pane. The joystick keeps
// tap=commit, drag=arrows, hold=record. Its glyph swaps to a send
// arrow when the draft has text, otherwise a mic.
//
// Two transient affordances sit above the textarea:
//   - a pending-voice banner (Confirm / Discard) when there's a
//     dictated transcript awaiting OK from the user;
//   - a "restore" chip when the draft was wiped by a non-composer
//     keystroke and the user has the option to re-stream it.

export function ActionTray() {
  const {
    draft,
    interim,
    recording,
    historyCursor,
    history,
    pendingVoice,
    stashedDraft,
  } = useSessionState();
  const actions = useSessionActions();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hasText = draft.trim().length > 0;
  const hasPending = pendingVoice.length > 0;
  const canRestore = draft === "" && stashedDraft !== null && stashedDraft !== "";

  useEffect(() => {
    document
      .getElementsByClassName("action-interim")[0]
      ?.scrollIntoView({ behavior: "smooth" });
  }, [interim]);

  // Scroll the interim text to the bottom when it changes.
  useEffect(() => {
    const el = document.getElementsByClassName("action-interim")[0];
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [interim]);

  // After history scrub, push the caret to end.
  useEffect(() => {
    const el = taRef.current;
    if (!el || document.activeElement !== el) return;
    el.setSelectionRange(el.value.length, el.value.length);
  }, [historyCursor]);

  // Joystick: arrows go to the PTY via pressKey, which also stashes
  // the draft so the user can restore.
  const fireDir = (dir: Dir) => {
    actions.pressKey(dir);
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
    // note this workaround was just turned off.
    // const ta = taRef.current;
    // if (ta && document.activeElement === ta) ta.blur();
    rootProps.onPointerDown(e);
  };

  return (
    <div className="action-tray" data-recording={recording}>
      <div className="action-pane">
        {hasPending && (
          <div
            className="action-pending"
            role="region"
            aria-label="voice transcript awaiting confirmation"
          >
            <div className="action-pending-text">{pendingVoice}</div>
            <div className="action-pending-actions">
              <button
                type="button"
                className="action-chip action-chip-confirm"
                onClick={() => actions.confirmPendingVoice()}
                aria-label="confirm voice transcript"
              >
                confirm
              </button>
              <button
                type="button"
                className="action-chip action-chip-discard"
                onClick={() => actions.discardPendingVoice()}
                aria-label="discard voice transcript"
              >
                discard
              </button>
            </div>
          </div>
        )}

        {!hasPending && canRestore && (
          <div className="action-restore">
            <button
              type="button"
              className="action-chip action-chip-restore"
              onClick={() => actions.restoreDraft()}
              aria-label="restore the draft that was cleared"
            >
              ↺ restore “{stashedDraft}”
            </button>
          </div>
        )}

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
          placeholder={recording ? "" : "Type, or hold the joystick to record."}
          aria-label="command draft"
          value={draft}
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

        <Waveform active={recording} useMic={recording} />

        <div className="action-interim" aria-live="polite">
          {interim}
        </div>
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
          <div className="joystick-knob" ref={knobRef}>
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
    <svg className="glyph" viewBox="0 0 25 25" aria-hidden="true">
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
    <svg className="glyph" viewBox="0 0 15 20" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M6.91 0.25a.83.83 0 0 1 1.18 0L14.76 7.11a.83.83 0 0 1-1.18 1.21L8.33 2.93v16.21a.83.83 0 0 1-1.67 0V2.93L1.42 8.32A.83.83 0 1 1 0.24 7.11L6.91 0.25Z"
      />
    </svg>
  );
}
