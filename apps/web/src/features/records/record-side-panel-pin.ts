export type RecordSideSurface = "format" | "member-leader" | "member-assignee" | "plain";

const PIN_STORAGE_PREFIX = "coforge.records.side-panel-pinned:";

/** Historical default: these surfaces opened the side chat on entry. */
export function defaultSidePanelPinned(surface: RecordSideSurface): boolean {
  return surface === "format" || surface === "member-leader" || surface === "member-assignee";
}

export function sidePanelPinStorageKey(subjectType: string, subjectId: string) {
  return `${PIN_STORAGE_PREFIX}${subjectType}:${subjectId}`;
}

export function readSidePanelPinned(
  subjectType: string,
  subjectId: string,
  surface: RecordSideSurface,
): boolean {
  if (typeof window === "undefined") return defaultSidePanelPinned(surface);
  const raw = window.localStorage.getItem(sidePanelPinStorageKey(subjectType, subjectId));
  if (raw === "1") return true;
  if (raw === "0") return false;
  return defaultSidePanelPinned(surface);
}

/**
 * Whether the panel starts open. Below `lg` it hides the document, so there only a pin the reader
 * made opens it; a `beside` panel follows the pinned state, default included.
 */
export function sidePanelOpensOnEntry(
  subjectType: string,
  subjectId: string,
  surface: RecordSideSurface,
  beside: boolean,
): boolean {
  if (beside) return readSidePanelPinned(subjectType, subjectId, surface);
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(sidePanelPinStorageKey(subjectType, subjectId)) === "1";
}

export function writeSidePanelPinned(subjectType: string, subjectId: string, pinned: boolean) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(sidePanelPinStorageKey(subjectType, subjectId), pinned ? "1" : "0");
}
