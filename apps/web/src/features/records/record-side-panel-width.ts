// How wide the Record side panel is: the width the reader last dragged it to, kept in this browser.

const SIDE_PANEL_WIDTH_STORAGE_KEY = "coforge.records.side-panel-width";
export const DEFAULT_SIDE_PANEL_WIDTH = 384;
export const MIN_SIDE_PANEL_WIDTH = 280;
export const SIDE_PANEL_WIDTH_TRANSITION = "width 220ms cubic-bezier(0.32, 0.72, 0, 1)";

/** Its drag edge; below `lg` the panel has the column to itself, so there is nothing to drag. */
export const SIDE_PANEL_RESIZE_HANDLE_CLASS =
  "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none hover:bg-brand-solid/20 active:bg-brand-solid/30 max-lg:hidden";

/**
 * The width the panel takes in a parent `parentWidth` wide. From `lg` it sits `beside` the document
 * and takes at most half; below that the document is hidden while it is open, so it fills the parent.
 */
export function fitSidePanelWidth(width: number, parentWidth: number, beside: boolean): number {
  if (!beside) return parentWidth;
  return Math.min(Math.max(width, MIN_SIDE_PANEL_WIDTH), Math.floor(parentWidth / 2));
}

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
