// How wide the Record side panel is: the width the reader last dragged it to, kept in this browser.

const SIDE_PANEL_WIDTH_STORAGE_KEY = "coforge.records.side-panel-width";
export const DEFAULT_SIDE_PANEL_WIDTH = 384;
export const MIN_SIDE_PANEL_WIDTH = 280;
export const SIDE_PANEL_WIDTH_TRANSITION = "width 220ms cubic-bezier(0.32, 0.72, 0, 1)";

export function readStoredSidePanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_SIDE_PANEL_WIDTH;
  const raw = window.localStorage.getItem(SIDE_PANEL_WIDTH_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_SIDE_PANEL_WIDTH;
  return Math.max(MIN_SIDE_PANEL_WIDTH, parsed);
}

export function writeStoredSidePanelWidth(width: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SIDE_PANEL_WIDTH_STORAGE_KEY, String(Math.round(width)));
}
