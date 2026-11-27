import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Store } from "@tanstack/react-store";
import { useAppToast } from "#src/components/ui/toast";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { scrollToMessageRow, scrollTwice } from "./conversation-scroll-anchor";
import type { ConversationBottomPin } from "./conversation-bottom-pin";
import { positionJumpDecision } from "./conversation-thread-search";
import type { ConversationUiState } from "./conversation-ui-store";
import { JUMP_HIGHLIGHT_MS } from "./message-jump-highlight";

const UUID_LIKE = new RegExp(`^${UUID_LIKE_SOURCE}$`, "i");

export function tellJumpFailure(toast: ReturnType<typeof useAppToast>, error: unknown) {
  if (isAppErrorCode(error, "NOT_FOUND")) toast.notice(m.conversation_message_gone());
  else if (isAppErrorCode(error, "AMBIGUOUS_TARGET"))
    toast.notice(m.conversation_message_link_ambiguous());
  else toast.error(m.conversation_history_load_error());
}

export function useMessageJump({
  messages,
  openedSystemMessages,
  revealSystemMessage,
  jumpMessage,
  onJumpMessageConsumed,
  onLoadMessageAround,
  setFollowingLatest,
  scrollToLatest,
  bottomPin,
  uiStore,
}: {
  messages: readonly { id: string; sequence: number }[];
  openedSystemMessages: ReadonlySet<string>;
  revealSystemMessage: (messageId: string) => boolean;
  jumpMessage: string | undefined;
  onJumpMessageConsumed: (() => void) | undefined;
  onLoadMessageAround: ((messageId: string) => Promise<string>) | undefined;
  setFollowingLatest: (following: boolean) => void;
  scrollToLatest: (behavior: ScrollBehavior) => void;
  bottomPin: ConversationBottomPin;
  uiStore: Store<ConversationUiState>;
}): void {
  const toast = useAppToast();
  useEffect(
    () => () => {
      toast.dismissShown(m.conversation_message_gone());
      toast.dismissShown(m.conversation_message_link_ambiguous());
      toast.dismissShown(m.conversation_history_load_error());
    },
    [toast],
  );
  const firstSequence = messages[0]?.sequence;
  const pendingMessageIdRef = useRef<string | undefined>(undefined);
  const jumpHighlightTimer = useRef<number | undefined>(undefined);
  const flashMessageRow = useCallback(
    (messageId: string) => {
      uiStore.setState((current) =>
        current.jumpHighlightId === messageId
          ? current
          : { ...current, jumpHighlightId: messageId },
      );
      window.clearTimeout(jumpHighlightTimer.current);
      jumpHighlightTimer.current = window.setTimeout(() => {
        uiStore.setState((current) =>
          current.jumpHighlightId === messageId
            ? { ...current, jumpHighlightId: undefined }
            : current,
        );
      }, JUMP_HIGHLIGHT_MS);
    },
    [uiStore],
  );
  useEffect(() => () => window.clearTimeout(jumpHighlightTimer.current), []);
  const landedOn = (row: Element) => {
    const history = row.closest<HTMLDivElement>("[data-scroll-restoration-id]");
    if (history && bottomPin.landed(history)) setFollowingLatest(true);
  };
  const revealSystemMessageRef = useRef(revealSystemMessage);
  revealSystemMessageRef.current = revealSystemMessage;

  const flashedAnchorRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      const scroll = () => {
        const message = document.getElementById(anchor);
        if (!message) {
          const messageId = anchor.slice("message-".length);
          if (revealSystemMessageRef.current(messageId)) {
            setFollowingLatest(false);
            pendingMessageIdRef.current = messageId;
          }
          return;
        }
        setFollowingLatest(false);
        message.scrollIntoView({ block: "center" });
        landedOn(message);
        if (flashedAnchorRef.current !== anchor) {
          flashedAnchorRef.current = anchor;
          flashMessageRow(anchor.slice("message-".length));
        }
      };
      scroll();
      requestAnimationFrame(scroll);
    }
    scrollToMessageAnchor();
    window.addEventListener("hashchange", scrollToMessageAnchor);
    return () => window.removeEventListener("hashchange", scrollToMessageAnchor);
  }, [firstSequence]);

  useLayoutEffect(() => {
    const messageId = pendingMessageIdRef.current;
    if (!messageId) return;
    const message = document.getElementById(`message-${messageId}`);
    if (!message) {
      revealSystemMessage(messageId);
      return;
    }
    pendingMessageIdRef.current = undefined;
    scrollToMessageRow(messageId, landedOn);
    flashMessageRow(messageId);
  }, [messages, openedSystemMessages, flashMessageRow]);

  async function showMessage(messageId: string, { opening = false } = {}) {
    const loaded = messages.some((message) => message.id === messageId);
    setFollowingLatest(false);
    if (!loaded) {
      if (!onLoadMessageAround) return;
      const whole = UUID_LIKE.test(messageId);
      if (whole) pendingMessageIdRef.current = messageId;
      try {
        const landed = await onLoadMessageAround(messageId);
        if (!whole) {
          if (document.getElementById(`message-${landed}`)) {
            scrollToMessageRow(landed, landedOn);
            flashMessageRow(landed);
          } else pendingMessageIdRef.current = landed;
        }
      } catch (error) {
        pendingMessageIdRef.current = undefined;
        tellJumpFailure(toast, error);
        if (opening) {
          setFollowingLatest(true);
          scrollTwice(() => scrollToLatest("instant"));
        }
      }
      return;
    }
    if (revealSystemMessage(messageId)) {
      pendingMessageIdRef.current = messageId;
      return;
    }
    scrollToMessageRow(messageId, landedOn);
    flashMessageRow(messageId);
  }

  const attemptedJumpRef = useRef<string | undefined>(undefined);
  const showMessageRef = useRef(showMessage);
  showMessageRef.current = showMessage;
  useEffect(() => {
    const decision = positionJumpDecision(
      jumpMessage,
      window.location.hash,
      attemptedJumpRef.current,
    );
    if (decision.action === "idle") {
      attemptedJumpRef.current = undefined;
      return;
    }
    if (decision.action === "ignore") return;
    attemptedJumpRef.current = decision.id;
    if (decision.action === "show") void showMessageRef.current(decision.id, { opening: true });
    onJumpMessageConsumed?.();
  }, [jumpMessage, onJumpMessageConsumed]);
}
