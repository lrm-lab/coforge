/**
 * Per-device collapse state for the Chat sidebar's CHANNELS / DIRECT MESSAGES groups.
 * Read only after mount (see `conversation-directory.tsx`) so SSR markup never depends on it —
 * same reasoning as `local-layout-storage.ts`, where touching `localStorage` during Nitro's
 * `renderToReadableStream` throws.
 */
const DIRECTORY_SECTION_IDS = ["pinned", "channels", "agents"] as const;
export type DirectorySectionId = (typeof DIRECTORY_SECTION_IDS)[number];

/** The sections a member can collapse. Pinned is a section (it takes drops, it can be hidden when
 * empty) but not a collapsible one: the design mockup gives it a pin and no chevron. */
const COLLAPSIBLE_SECTION_IDS = ["channels", "agents"] as const;
export type CollapsibleSectionId = (typeof COLLAPSIBLE_SECTION_IDS)[number];

const STORAGE_KEY = "coforge-chat-sections-collapsed";

/** Collapsed sections, as a set of ids. An unreadable or malformed value means "all expanded", and
 * so does an id that cannot collapse — including "pinned", stored by a device that collapsed it
 * back when it could. */
export function readCollapsedSections(): CollapsibleSectionId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is CollapsibleSectionId => COLLAPSIBLE_SECTION_IDS.includes(id));
  } catch {
    return [];
  }
}

export function writeCollapsedSections(ids: CollapsibleSectionId[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Private mode or blocked storage: the toggle still works for this page.
  }
}

/**
 * Whether a Chat sidebar section may be hidden by Settings → Hide empty sidebar sections: it has
 * no rows. While a row is dragged, a section that takes drops (Pinned) comes back so the row can
 * be dropped into it. Counts come from the lists as they were when the drag started, so a
 * section the row was dragged out of stays until it is dropped. The setting itself is a class on
 * <html> (`features/settings/hide-empty-sidebar-sections.ts`); sections with creation actions stay
 * visible.
 */
export function directorySectionHideable({
  itemCount,
  dragging,
  revealWhileDragging = false,
}: {
  itemCount: number;
  dragging: boolean;
  revealWhileDragging?: boolean;
}): boolean {
  return itemCount === 0 && !(dragging && revealWhileDragging);
}
