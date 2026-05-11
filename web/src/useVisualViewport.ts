// Mirrors visualViewport metrics onto CSS custom properties so the
// bottom-anchored layout stays glued to the keyboard on mobile.
//
//   --vv-top  — distance from layout viewport top to visual viewport top
//   --vv-h    — visual viewport height

import { useEffect } from "react";

export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement.style;
    const sync = () => {
      const vv = window.visualViewport;
      if (vv) {
        root.setProperty("--vv-top", `${vv.offsetTop}px`);
        root.setProperty("--vv-h", `${vv.height}px`);
      } else {
        root.setProperty("--vv-top", "0px");
        root.setProperty("--vv-h", `${window.innerHeight}px`);
      }
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      window.visualViewport?.removeEventListener("resize", sync);
      window.visualViewport?.removeEventListener("scroll", sync);
    };
  }, []);
}
