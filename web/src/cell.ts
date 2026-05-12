// Cell metrics for the terminal font. Single source of truth for both
// xterm's font sizing (terminal.ts) and the client-side geometry
// prediction used to request a phone-fitting PTY (RawTerminal.tsx).
//
// The cell width is *measured* against the chosen font family via
// canvas.measureText, not approximated from a hard-coded advance ratio
// like 0.6. This makes the calculation correct for any monospace family
// and survives font-stack changes without retuning.

export const FONT_FAMILY =
  'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
export const FONT_SIZE = 14;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 18;
export const LINE_HEIGHT = 1.15;

// Advance width per em, measured once per family and cached. We measure
// at a large reference size to dilute hinting/sub-pixel rounding noise,
// then divide to get the ratio.
const ratioCache = new Map<string, { h: number; w: number }>();
export function cellMetrics(
  fontSize: number = FONT_SIZE,
  family: string = FONT_FAMILY,
): { h: number; w: number } {
  const cached = ratioCache.get(family);
  if (cached !== undefined) return cached;
  if (typeof document === "undefined") return { h: 0, w: 0 };
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return { h: 0, w: 0 };
  ctx.font = `${fontSize}px ${family}`;
  const metrics = ctx.measureText("M");
  const r = {
    h:
      (metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) *
      LINE_HEIGHT,
    w: metrics.width * fontSize,
  };
  ratioCache.set(family, r);
  return r;
}

export function cellSize(
  fontSize: number = FONT_SIZE,
  family: string = FONT_FAMILY,
): { w: number; h: number } {
  const cellM = cellMetrics(fontSize, family);
  return cellM;
}

export function elementPadding(el: HTMLElement): { x: number; y: number } {
  const cs = getComputedStyle(el);
  return {
    x: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight),
    y: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
  };
}
