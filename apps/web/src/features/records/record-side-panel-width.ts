export const DEFAULT_SIDE_PANEL_WIDTH = 24;
export const MIN_SIDE_PANEL_WIDTH = 17.5;
export const MAIN_COLUMN_MIN_REM = 20;
export const DOCK_SPLIT_MIN_REM = MAIN_COLUMN_MIN_REM + MIN_SIDE_PANEL_WIDTH;

export function readRootFontSizePx(): number {
  if (typeof window === "undefined") return 16;
  const parsed = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16;
}

export function canDockSidePanel(
  parentWidthPx: number,
  beside: boolean,
  rootFontSizePx = 16,
): boolean {
  if (!beside) return false;
  return parentWidthPx >= DOCK_SPLIT_MIN_REM * rootFontSizePx;
}
