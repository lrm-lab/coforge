import { ROW_TOP_GAP_PX } from "./conversation-scroll-anchor";

/** How close to the bottom the pane must be for a content-resize to re-pin it (see the pinning
 * ResizeObserver). Tight on purpose: the reading position itself uses a wider tolerance. */
export const PIN_TOLERANCE_PX = 4;

type HistoryPosition = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/**
 * Bottom-follow intent across layout changes and the scroll events those changes trigger.
 * A banner can shrink the viewport before an earlier programmatic scroll is delivered; native
 * scroll anchoring can also move it down as content grows. Neither is the reader moving away.
 * Reading input retires that programmatic position before its scroll event, even if layout
 * changes in the same frame. The normal scroll observation then takes over.
 */
export class ConversationBottomPin {
  #distance = 0;
  #pinned: HistoryPosition | undefined;

  pin(history: HTMLDivElement | null, behavior: ScrollBehavior) {
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
    this.#distance = 0;
    this.#pinned = {
      scrollTop: history.scrollTop,
      scrollHeight: history.scrollHeight,
      clientHeight: history.clientHeight,
    };
  }

  /**
   * Scrolls to the row a pane opens on, its top `ROW_TOP_GAP_PX` below the top: the whole row, so
   * its unread and day dividers show. A row the history cannot scroll that far for (it and every
   * row after it fit in view) lands at the bottom, and that is a pin like the latest's: what fills
   * in later (reactions, a thread's preview) must not leave the reader short of the end. Native
   * scroll anchoring's scroll event reaches `scroll` before the resize does, so without the pin it
   * would read as the reader moving away. Returns whether it pinned.
   */
  open(history: HTMLDivElement, row: Element): boolean {
    // The row's own offset, straight from layout: every row is in normal flow and laid out at its
    // real height, so this is exact — there is no estimate to correct later.
    const offset =
      row.getBoundingClientRect().top - history.getBoundingClientRect().top + history.scrollTop;
    const top = Math.max(0, offset - ROW_TOP_GAP_PX);
    if (top < history.scrollHeight - history.clientHeight - PIN_TOLERANCE_PX) {
      history.scrollTo({ top });
      return false;
    }
    this.pin(history, "instant");
    return true;
  }

  readonly read = () => {
    this.#pinned = undefined;
  };

  scroll(history: HistoryPosition): number | undefined {
    const pinned = this.#pinned;
    if (
      pinned &&
      history.scrollTop >= pinned.scrollTop &&
      (history.scrollTop === pinned.scrollTop ||
        history.scrollHeight !== pinned.scrollHeight ||
        history.clientHeight !== pinned.clientHeight)
    )
      return undefined;
    this.#pinned = undefined;
    return (this.#distance = distanceFromBottom(history));
  }

  beforeResize(history: HistoryPosition): boolean {
    const wasAtBottom = this.#distance <= PIN_TOLERANCE_PX;
    this.#distance = distanceFromBottom(history);
    return wasAtBottom;
  }
}

function distanceFromBottom(history: HistoryPosition): number {
  return history.scrollHeight - history.scrollTop - history.clientHeight;
}
