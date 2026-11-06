import { ROW_TOP_GAP_PX } from "./conversation-scroll-anchor";

/** How close to the bottom the pane must be for a content-resize to re-pin it (see the pinning
 * ResizeObserver). Tight on purpose: the reading position itself uses a wider tolerance. */
export const PIN_TOLERANCE_PX = 4;

/** How long a message jump's landing is re-asserted against late layout: the unread divider's
 * open read and settling rows can still move the row for a beat after the jump scrolls. */
const JUMP_REASSERT_MS = 2_000;

type HistoryPosition = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

/** The reader's input on the history: a wheel, a key, a touch or a press. */
type ReadingInput = {
  type: string;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
  deltaY?: number;
  key?: string;
  shiftKey?: boolean;
  touches?: ArrayLike<{ identifier: number; clientY: number }>;
};

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
  /** The message a jump just landed on, re-centered on each resize while late layout can still
   * move it — a scroll event that lands after such growth reads as the reader having moved away,
   * so without this the jump can be left short of its row. */
  #jumped: { id: string; at: number } | undefined;
  /** The reader touched the history since the jump: their input ends the re-assert at once. */
  #readerTookOver = false;
  /** Where the history stood when the reader asked to move up, until a scroll shows their move:
   * a row settling in between must not pull them back (task #567). Native scroll anchoring's
   * scroll, further down, is not theirs; the first scroll at or above it is, wherever it lands
   * (a small move that stays at the bottom keeps following). A pin or input toward the bottom
   * also ends it. */
  #leavingFrom: number | undefined;
  /** The last touch point, to tell which way a drag scrolls. */
  #touch: { identifier: number; clientY: number } | undefined;

  pin(history: HTMLDivElement | null, behavior: ScrollBehavior) {
    if (!history) return;
    history.scrollTo({ top: history.scrollHeight, behavior });
    history.scrollTop = history.scrollHeight;
    this.#distance = 0;
    this.#leavingFrom = undefined;
    this.#jumped = undefined;
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
    this.#jumped = undefined;
    if (top < history.scrollHeight - history.clientHeight - PIN_TOLERANCE_PX) {
      history.scrollTo({ top });
      return false;
    }
    this.pin(history, "instant");
    return true;
  }

  /** Marks a message jump's landing: for `JUMP_REASSERT_MS` each resize re-centers the row
   * (`reassertJumped`) instead of bottom-following, until the reader touches the history. */
  markJumped(messageId: string) {
    this.#jumped = { id: messageId, at: Date.now() };
    this.#readerTookOver = false;
  }

  /** Re-centers the row a fresh jump landed on, in the history it belongs to (a thread pane and
   * the main stream can hold the same message id). Returns whether it scrolled; a stale, taken-
   * over or gone landing clears itself and returns false so ordinary pinning resumes. */
  reassertJumped(history: HTMLElement): boolean {
    const jumped = this.#jumped;
    if (!jumped) return false;
    if (this.#readerTookOver || Date.now() - jumped.at >= JUMP_REASSERT_MS) {
      this.#jumped = undefined;
      return false;
    }
    const row = history.querySelector<HTMLElement>(`[id="message-${jumped.id}"]`);
    if (!row) {
      this.#jumped = undefined;
      return false;
    }
    row.scrollIntoView({ block: "center" });
    requestAnimationFrame(() => row.scrollIntoView({ block: "center" }));
    return true;
  }

  readonly read = (input?: ReadingInput) => {
    this.#pinned = undefined;
    if (input) this.#readerTookOver = true;
    const direction = input && this.#direction(input);
    if (direction === "down") this.#leavingFrom = undefined;
    else if (direction === "up" && input && scrollsHistoryUp(input))
      this.#leavingFrom = (input.currentTarget as Element).scrollTop;
  };

  #direction(input: ReadingInput): "up" | "down" | undefined {
    if (input.type === "wheel" && input.deltaY) return input.deltaY < 0 ? "up" : "down";
    if (input.type === "keydown" && !isEditing(input.target)) {
      if (input.key === " ") return input.shiftKey ? "up" : "down";
      if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home") return "up";
      if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === "End")
        return "down";
    }
    const touch = input.type === "touchmove" ? input.touches?.[0] : undefined;
    if (!touch) return undefined;
    const previous = this.#touch;
    this.#touch = { identifier: touch.identifier, clientY: touch.clientY };
    if (previous?.identifier !== touch.identifier || previous.clientY === touch.clientY)
      return undefined;
    // A finger moving down drags the content down: the history scrolls toward its top.
    return touch.clientY > previous.clientY ? "up" : "down";
  }

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
    this.#distance = distanceFromBottom(history);
    if (this.#leavingFrom !== undefined && history.scrollTop <= this.#leavingFrom)
      this.#leavingFrom = undefined;
    return this.#distance;
  }

  beforeResize(history: HistoryPosition): boolean {
    const wasAtBottom = this.#leavingFrom === undefined && this.#distance <= PIN_TOLERANCE_PX;
    this.#distance = distanceFromBottom(history);
    return wasAtBottom;
  }
}

/** Whether the input scrolls the history itself rather than something inside it that can still
 * scroll up (a code block, a tool's output): scroll chaining gives it to the innermost. */
function scrollsHistoryUp({ target, currentTarget: history }: ReadingInput): boolean {
  if (!history || (history as Element).scrollTop <= 0) return false;
  for (
    let element = target as Element | null;
    element && element !== history;
    element = element.parentElement
  ) {
    if (
      element.scrollTop > 0 &&
      element.scrollHeight > element.clientHeight &&
      /auto|scroll/.test(getComputedStyle(element).overflowY)
    )
      return false;
  }
  return true;
}

/** A key typed into a field (editing a message in place) moves its caret, not the history. */
function isEditing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName))
  );
}

function distanceFromBottom(history: HistoryPosition): number {
  return history.scrollHeight - history.scrollTop - history.clientHeight;
}
