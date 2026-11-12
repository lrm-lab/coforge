import { useLayoutEffect, type RefObject } from "react";

import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";

/** The room left between the card and the dock below it, and the stream's top edge. */
const MARGIN_PX = 12;

/**
 * Keeps the card being answered in sight above the dock (Frank, 11-12): once the dock has taken the
 * composer's place, the stream scrolls only as far as it takes to show that card whole, and not at
 * all when it already shows. Its own scroll handler then reads the new position, as for any other
 * scroll. On a phone the dock is a sheet over the stream, which stays where it was: the caller
 * passes no card there.
 */
export function useDockKeepsCardInView(
  historyRef: RefObject<HTMLElement | null>,
  messageId: string | undefined,
  state: string | undefined,
) {
  const reduceMotion = usePrefersReducedMotion();
  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history || !messageId) return;
    const card = history.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"] [data-question-card]`,
    );
    if (!card) return;
    const box = card.getBoundingClientRect();
    const frame = history.getBoundingClientRect();
    const bottom = frame.bottom - MARGIN_PX;
    const top = frame.top + MARGIN_PX;
    // A card taller than the room left shows its top.
    const by =
      box.top < top || box.height > bottom - top
        ? box.top - top
        : box.bottom > bottom
          ? box.bottom - bottom
          : 0;
    if (!by) return;
    history.scrollBy({ top: by, behavior: reduceMotion ? "auto" : "smooth" });
  }, [historyRef, messageId, state, reduceMotion]);
}
