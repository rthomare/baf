import { useEffect, useState } from "react";
import { Overflow } from "./Overflow";

// Floating settings (sliders) button at the top of the screen. Owns
// both the trigger and the overflow popup. The trigger fades out
// while the user is actively scrolling the terminal — autoscroll from
// PTY output doesn't fire touchmove/wheel, so it only hides when the
// user themselves is interacting with the buffer.

export function FloatingSettings() {
  const [open, setOpen] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  useEffect(() => {
    let timer: number | null = null;
    let viewport: HTMLElement | null = null;
    let raf = 0;

    const onUserScroll = () => {
      setScrolling(true);
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(() => {
        setScrolling(false);
        timer = null;
      }, 600);
    };

    // xterm mounts asynchronously; poll for the viewport via rAF
    // until it appears, then attach. This avoids racing the terminal
    // singleton initialization.
    const attach = () => {
      viewport = document.getElementsByClassName(
        "xterm-viewport",
      )[0] as HTMLElement | null;
      if (!viewport) {
        raf = requestAnimationFrame(attach);
        return;
      }
      viewport.addEventListener("touchmove", onUserScroll, { passive: true });
      viewport.addEventListener("wheel", onUserScroll, { passive: true });
    };
    attach();

    return () => {
      cancelAnimationFrame(raf);
      if (viewport) {
        viewport.removeEventListener("touchmove", onUserScroll);
        viewport.removeEventListener("wheel", onUserScroll);
      }
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <button
        id="settings-toggle"
        type="button"
        className="floating-settings"
        data-hidden={scrolling && !open}
        aria-label="terminal shortcuts"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersGlyph />
      </button>
      <Overflow open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function SlidersGlyph() {
  return (
    <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      >
        <line x1="6" y1="4" x2="6" y2="9" />
        <line x1="6" y1="13" x2="6" y2="20" />
        <line x1="12" y1="4" x2="12" y2="14" />
        <line x1="12" y1="18" x2="12" y2="20" />
        <line x1="18" y1="4" x2="18" y2="7" />
        <line x1="18" y1="11" x2="18" y2="20" />
        <circle cx="6" cy="11" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="12" cy="16" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="18" cy="9" r="1.6" fill="currentColor" stroke="none" />
      </g>
    </svg>
  );
}

