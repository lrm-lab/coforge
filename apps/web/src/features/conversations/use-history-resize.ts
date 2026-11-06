import { useLayoutEffect, type RefObject } from "react";
import type { ConversationBottomPin } from "./conversation-bottom-pin";

/**
 * What a resize of the history means for the reading position. An open position the pane could
 * not apply yet (a hidden branch has no height to scroll within) gets its retry here, and a reader
 * who stood at the bottom is carried along. `ConversationBottomPin` decides that from where the
 * reader stood BEFORE the resize — a ResizeObserver callback runs after layout, so `scrollHeight`
 * already includes the growth.
 */
export function useHistoryResize({
  historyRef,
  messageListRef,
  pendingOpenMessageIdRef,
  bottomPin,
  followingLatestRef,
  applyOpenPosition,
  scrollToLatest,
  conversationId,
  listIsEmpty,
}: {
  historyRef: RefObject<HTMLDivElement | null>;
  messageListRef: RefObject<HTMLOListElement | null>;
  pendingOpenMessageIdRef: RefObject<string | undefined>;
  bottomPin: ConversationBottomPin;
  followingLatestRef: RefObject<boolean>;
  applyOpenPosition: () => void;
  scrollToLatest: (behavior: ScrollBehavior) => void;
  conversationId: string;
  listIsEmpty: boolean;
}) {
  useLayoutEffect(() => {
    const history = historyRef.current;
    if (!history) return;
    const observer = new ResizeObserver(() => {
      if (pendingOpenMessageIdRef.current) {
        applyOpenPosition();
        return;
      }
      const wasAtBottom = bottomPin.beforeResize(history);
      // Only a reader genuinely AT the bottom is carried along, never one within the 48px "near
      // enough" tolerance the reading position uses: re-pinning from 48px fought a reader who had
      // scrolled up a little, and every deliberate scroll-up must stand.
      if (!followingLatestRef.current || !wasAtBottom) return;
      scrollToLatest("instant");
    });
    observer.observe(history);
    if (messageListRef.current) observer.observe(messageListRef.current);
    return () => observer.disconnect();
  }, [conversationId, listIsEmpty]);
}
