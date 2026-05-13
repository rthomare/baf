import { useEffect, useState } from "react";
import { getXterm } from "../xterm-singleton";
import { getTransport } from "../transport";

// The FAB shows whenever xterm's visible viewport isn't at the bottom.
// Recompute on (a) xterm scroll, (b) every chunk of PTY output.
export function ScrollBottomButton() {
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const xtermViewport = document.getElementsByClassName(
      "xterm-viewport",
    )[0] as HTMLElement | null;
    if (!xtermViewport) return;
    const xt = getXterm();

    const compute = () => {
      const buf = xt.term.buffer?.active;
      setAtBottom(!buf || buf.viewportY >= buf.baseY);
    };

    compute();
    xtermViewport.addEventListener("scroll", compute, { passive: true });
    const xtDispose = xt.term.onScroll(compute);
    const tDispose = getTransport().onOutput(compute);

    return () => {
      xtermViewport.removeEventListener("scroll", compute);
      xtDispose.dispose();
      tDispose();
    };
  }, []);

  const onClick = () => {
    const xtermViewport = document.getElementsByClassName(
      "xterm-viewport",
    )[0] as HTMLElement | null;
    if (!xtermViewport) return;
    xtermViewport.scrollTo({
      top: xtermViewport.scrollHeight,
      behavior: "smooth",
    });
    setAtBottom(true);
  };

  return (
    <button
      id="scroll-bottom"
      type="button"
      data-visible={!atBottom}
      aria-label="scroll to latest output"
      title="scroll to latest"
      onClick={onClick}
    >
      ↓
    </button>
  );
}
