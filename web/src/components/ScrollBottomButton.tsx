import { useEffect, useState } from "react";
import { useSessionState } from "../SessionContext";
import { getXterm } from "../xterm-singleton";
import { getTransport } from "../transport";

const BLOCK_BOTTOM_SLACK_PX = 24;

// The FAB shows whenever the visible area isn't at the bottom in
// whichever view is active. Recompute on (a) the relevant scroll event,
// (b) every chunk of PTY output, and (c) view-mode change.
export function ScrollBottomButton() {
  const { viewMode } = useSessionState();
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const xtermViewport = document.getElementsByClassName(
      "xterm-viewport",
    )[0] as HTMLElement | null;
    if (!xtermViewport) return;
    const xt = getXterm();

    const compute = () => {
      if (viewMode === "block") {
        const dist =
          xtermViewport.scrollHeight -
          xtermViewport.scrollTop -
          xtermViewport.clientHeight;
        setAtBottom(dist < BLOCK_BOTTOM_SLACK_PX);
      } else {
        const buf = xt.term.buffer?.active;
        setAtBottom(!buf || buf.viewportY >= buf.baseY);
      }
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
  }, [viewMode]);

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
