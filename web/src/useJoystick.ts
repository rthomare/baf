// Joystick gesture state machine.
//
//   tap   → onTap()              (press, no significant motion, no hold timer)
//   drag  → onDragFire(dir)      (motion past threshold; auto-repeats)
//   hold  → onHoldStart/End()    (still pressed after HOLD_MS)
//
// State changes are reflected back via a `state` field so the component
// can style the knob and arrow indicators.

import { useCallback, useEffect, useRef, useState } from "react";
import { haptic } from "./haptics";

export type GestureState = "idle" | "pressed" | "dragging" | "holding";
export type Dir = "up" | "down" | "left" | "right";

const HOLD_MS = 280;
const MOVE_THRESHOLD = 14;
const KNOB_MAX_OFFSET = 18;
const REPEAT_INITIAL_DELAY = 380;
const REPEAT_INTERVAL = 90;

export interface JoystickHandlers {
  onTap: () => void;
  onDragFire: (dir: Dir) => void;
  onHoldStart: () => void;
  onHoldEnd: () => void;
}

export interface JoystickApi {
  state: GestureState;
  activeDir: Dir | null;
  knobRef: React.RefObject<HTMLDivElement>;
  rootProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

function dominantDir(dx: number, dy: number): Dir {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function useJoystick(handlers: JoystickHandlers): JoystickApi {
  const [state, setState] = useState<GestureState>("idle");
  const [activeDir, setActiveDir] = useState<Dir | null>(null);
  const knobRef = useRef<HTMLDivElement>(null);

  // Refs held across pointer events; they don't drive renders.
  const stateRef = useRef<GestureState>("idle");
  const pointerIdRef = useRef(-1);
  const startRef = useRef({ x: 0, y: 0 });
  const dirRef = useRef<Dir | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const repeatTimerRef = useRef<number | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const setGesture = useCallback((g: GestureState) => {
    stateRef.current = g;
    setState(g);
  }, []);

  const setKnobOffset = useCallback((dx: number, dy: number) => {
    const knob = knobRef.current;
    if (!knob) return;
    const len = Math.hypot(dx, dy);
    if (len > KNOB_MAX_OFFSET) {
      const k = KNOB_MAX_OFFSET / len;
      dx *= k;
      dy *= k;
    }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  }, []);

  const cancelTimers = useCallback(() => {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (repeatTimerRef.current !== null) {
      clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
  }, []);

  const startRepeat = useCallback((dir: Dir) => {
    cancelTimers();
    const tick = () => {
      if (stateRef.current !== "dragging" || dirRef.current !== dir) return;
      handlersRef.current.onDragFire(dir);
      repeatTimerRef.current = window.setTimeout(tick, REPEAT_INTERVAL);
    };
    repeatTimerRef.current = window.setTimeout(tick, REPEAT_INITIAL_DELAY);
  }, [cancelTimers]);

  // Cleanup on unmount.
  useEffect(() => cancelTimers, [cancelTimers]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    if (stateRef.current !== "idle") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointerIdRef.current = e.pointerId;
    startRef.current = { x: e.clientX, y: e.clientY };
    setGesture("pressed");
    haptic.light();
    holdTimerRef.current = window.setTimeout(() => {
      if (stateRef.current !== "pressed") return;
      setGesture("holding");
      haptic.heavy();
      handlersRef.current.onHoldStart();
    }, HOLD_MS);
  }, [setGesture]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (e.pointerId !== pointerIdRef.current) return;
    const s = stateRef.current;
    if (s === "holding" || s === "idle") return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (s === "pressed") {
      if (Math.hypot(dx, dy) < MOVE_THRESHOLD) return;
      cancelTimers();
      setGesture("dragging");
      haptic.medium();
    }
    if (stateRef.current === "dragging") {
      setKnobOffset(dx, dy);
      const dir = dominantDir(dx, dy);
      if (dir !== dirRef.current) {
        dirRef.current = dir;
        setActiveDir(dir);
        haptic.selection();
        handlersRef.current.onDragFire(dir);
        startRepeat(dir);
      }
    }
  }, [cancelTimers, setGesture, setKnobOffset, startRepeat]);

  const endGesture = useCallback(() => {
    const prev = stateRef.current;
    cancelTimers();
    setKnobOffset(0, 0);
    setActiveDir(null);
    if (prev === "pressed") {
      haptic.medium();
      handlersRef.current.onTap();
    } else if (prev === "holding") {
      haptic.light();
      handlersRef.current.onHoldEnd();
    }
    dirRef.current = null;
    pointerIdRef.current = -1;
    setGesture("idle");
  }, [cancelTimers, setGesture, setKnobOffset]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.pointerId === pointerIdRef.current) endGesture();
  }, [endGesture]);

  const onPointerCancel = useCallback((e: React.PointerEvent) => {
    if (e.pointerId === pointerIdRef.current) endGesture();
  }, [endGesture]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handlersRef.current.onTap();
    }
  }, []);

  return {
    state,
    activeDir,
    knobRef,
    rootProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown },
  };
}
