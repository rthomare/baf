// Tiny haptics wrapper.
//
// Two backends, called in parallel — each is a no-op where the other
// is real, so we never need to detect the platform:
//
//   - navigator.vibrate(ms)         → Android Chrome / Firefox
//   - <input type="checkbox" switch> → iOS Safari 17.4+. Toggling it
//                                      fires a single system haptic.
//                                      Intensity isn't selectable on
//                                      iOS, so light/medium/heavy all
//                                      collapse to the same feel.
//
// All callers go through the named levels rather than raw ms so we can
// retune one knob later without touching call sites.

let iosSwitch: HTMLInputElement | null = null;

function ensureIosSwitch(): HTMLInputElement {
  if (iosSwitch) return iosSwitch;
  const el = document.createElement("input");
  el.type = "checkbox";
  // The `switch` attribute is iOS-specific. Other browsers ignore it.
  el.setAttribute("switch", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  el.tabIndex = -1;
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  iosSwitch = el;
  return el;
}

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms);
  } catch { /* some sandboxes throw; ignore */ }
  const sw = ensureIosSwitch();
  sw.checked = !sw.checked;
}

export const haptic = {
  /** Direction nudge — finest, used during continuous gestures. */
  selection: () => buzz(3),
  /** Single tap acknowledgement — pointerdown, key press. */
  light:     () => buzz(6),
  /** State change — entered drag, submitted, stopped recording. */
  medium:    () => buzz(14),
  /** Big state change — entered hold/recording. */
  heavy:     () => buzz(24),
};
