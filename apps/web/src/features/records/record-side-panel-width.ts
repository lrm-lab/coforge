const SIDE_PANEL_WIDTH_STORAGE_KEY = "coforge.records.side-panel-width";
export const DEFAULT_SIDE_PANEL_WIDTH = 24;
export const MIN_SIDE_PANEL_WIDTH = 17.5;
export const MAIN_COLUMN_MIN_REM = 20;
export const DOCK_SPLIT_MIN_REM = MAIN_COLUMN_MIN_REM + MIN_SIDE_PANEL_WIDTH;

const LEGACY_PX_THRESHOLD = 80;
const LEGACY_BASE_FONT_PX = 16;
const PLAIN_NUMBER = /^\d+(\.\d+)?$/;

export const SIDE_PANEL_RESIZE_HANDLE_CLASS =
  "absolute inset-y-0 -start-1 z-10 w-2 cursor-col-resize touch-none hover:bg-brand-solid/20 active:bg-brand-solid/30 max-lg:hidden";

export function roundSidePanelRem(value: number): number {
  return Math.round(value * 100) / 100;
}

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

export function maxDockedSidePanelWidth(parentWidthPx: number, rootFontSizePx = 16): number {
  const parentRem = parentWidthPx / rootFontSizePx;
  return roundSidePanelRem(Math.min(parentRem / 2, parentRem - MAIN_COLUMN_MIN_REM));
}

export function fitSidePanelWidth(
  widthRem: number,
  parentWidthPx: number,
  beside: boolean,
  rootFontSizePx = 16,
): number {
  const parentRem = roundSidePanelRem(parentWidthPx / rootFontSizePx);
  if (!beside) return parentRem;
  if (!canDockSidePanel(parentWidthPx, beside, rootFontSizePx)) {
    return Math.min(Math.max(widthRem, MIN_SIDE_PANEL_WIDTH), parentRem);
  }
  return Math.min(
    Math.max(widthRem, MIN_SIDE_PANEL_WIDTH),
    maxDockedSidePanelWidth(parentWidthPx, rootFontSizePx),
  );
}

export function parseSidePanelWidth(raw: string | null): number {
  if (raw === null || !PLAIN_NUMBER.test(raw)) return DEFAULT_SIDE_PANEL_WIDTH;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SIDE_PANEL_WIDTH;
  const rem = parsed > LEGACY_PX_THRESHOLD ? parsed / LEGACY_BASE_FONT_PX : parsed;
  return Math.max(MIN_SIDE_PANEL_WIDTH, roundSidePanelRem(rem));
}

export function readStoredSidePanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL_WIDTH;
  return parseSidePanelWidth(window.localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY));
}

export function writeStoredSidePanelWidth(widthRem: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(roundSidePanelRem(widthRem)));
}
