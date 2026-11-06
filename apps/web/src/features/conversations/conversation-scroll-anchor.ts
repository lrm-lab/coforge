/** The reading position around a page load: the row at the top of the viewport and its content's
 * offset, plus the raw height and scrollTop for the one case the row cannot cover. */
export interface ScrollAnchor {
  rowId?: string;
  offset: number;
  height: number;
  top: number;
}

/** The part of a row the reading position holds still: its text (`data-scroll-anchor`), or the
 * row itself for a row that marks none. A folded group's summary comes before any of its rows. */
export function scrollAnchorOf(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>("[data-scroll-anchor]") ?? row;
}

/** Snapshot the reading position before a load changes the list. The first row that is not
 * entirely above the container's top edge is the one the reader is looking at. */
export function captureScrollAnchor(history: HTMLDivElement): ScrollAnchor {
  const containerTop = history.getBoundingClientRect().top;
  let rowId: string | undefined;
  let offset = 0;
  for (const row of history.querySelectorAll<HTMLElement>("li[data-message-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= containerTop) continue;
    rowId = row.dataset.messageId;
    offset = scrollAnchorOf(row).getBoundingClientRect().top - containerTop;
    break;
  }
  return { rowId, offset, height: history.scrollHeight, top: history.scrollTop };
}

/** Put that row back at the same offset. A raw height delta would also move the reader by a page
 * evicted from the other end. The offset is measured on the row's content, not its edges: a load
 * changes what surrounds the text, while an image or reaction settling below it changes the bottom.
 * A folded system group is one row for all its notices, and its row id is its first notice, so a
 * page that extends the group backwards gives it a new first notice. The group that still holds
 * the anchored notice is the same row. A notice's own row comes first: an open group lists the
 * notices it shows and shares its first one's id. */
export function restoreScrollAnchor(
  history: HTMLDivElement | null,
  anchor: ScrollAnchor | undefined,
) {
  if (!anchor || !history) return;
  if (anchor.rowId) {
    const id = CSS.escape(anchor.rowId);
    const row =
      history.querySelector<HTMLElement>(`li[data-message-id="${id}"]:not([data-system-group])`) ??
      history.querySelector<HTMLElement>(`li[data-system-group-members~="${id}"]`);
    if (row) {
      const containerTop = history.getBoundingClientRect().top;
      const delta =
        scrollAnchorOf(row).getBoundingClientRect().top - (containerTop + anchor.offset);
      if (delta) history.scrollTop += delta;
      return;
    }
  }
  history.scrollTop = anchor.top + (history.scrollHeight - anchor.height);
}

/** The gap left above a row the pane scrolls to (`applyOpenPosition`). */
export const ROW_TOP_GAP_PX = 12;

/**
 * Runs a scroll now and again on the next frame. The router's scroll restoration
 * (`scrollRestoration: true` in `router.tsx`) rewrites the history's scrollTop in its
 * `onRendered` pass, which runs after a child's layout effect, so a single pass can be
 * overwritten by the entry cached for the pane. `data-scroll-restoration-id` on the history
 * keeps another conversation's offset from reaching this pane in the first place.
 */
export function scrollTwice(scroll: () => void) {
  scroll();
  requestAnimationFrame(scroll);
}

/** Centers a loaded message's row at once, in two passes like the hash landing: the router's
 * scroll restoration can rewrite the container after this frame. A jump never scrolls smoothly:
 * a smooth scroll that pages older history in is cut short by the paging scroll anchor. The row
 * flashes instead, as Slack's jump to a message does. */
export function scrollToMessageRow(messageId: string, landed: (row: Element) => void) {
  scrollTwice(() => {
    const row = document.getElementById(`message-${messageId}`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    landed(row);
  });
}
