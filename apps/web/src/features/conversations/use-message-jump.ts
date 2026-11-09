import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppToast } from "#src/components/ui/toast";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { scrollToMessageRow, scrollTwice } from "./conversation-scroll-anchor";
import type { ConversationBottomPin } from "./conversation-bottom-pin";
import { positionJumpDecision } from "./conversation-thread-search";
import { JUMP_HIGHLIGHT_MS } from "./message-jump-highlight";

const UUID_LIKE = new RegExp(`^${UUID_LIKE_SOURCE}$`, "i");

/**
 * Tells the viewer why a jump to a message did not land. A link to a message that is gone (deleted,
 * or never in this conversation) cannot load on a retry, so it says so instead of asking to try
 * again; a short id more than one message starts with says so rather than pick one (#34).
 */
export function tellJumpFailure(toast: ReturnType<typeof useAppToast>, error: unknown) {
  if (isAppErrorCode(error, "NOT_FOUND")) toast.notice(m.conversation_message_gone());
  else if (isAppErrorCode(error, "AMBIGUOUS_TARGET"))
    toast.notice(m.conversation_message_link_ambiguous());
  else toast.error(m.conversation_history_load_error());
}

/**
 * Every way the pane lands on one message — a `#message-` hash, the Saved view's `?message=`
 * param, the own-messages navigator's `showMessage` — plus the highlight the landed row keeps
 * for a moment. The pane keeps the open position (oldest unread or latest) and bottom-follow;
 * this hook owns only the jump-to-message paths and what they share: the pending row a folded
 * system group owes a scroll, and the flash that marks where a jump landed.
 */
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
}: {
  messages: readonly { id: string; sequence: number }[];
  openedSystemMessages: ReadonlySet<string>;
  revealSystemMessage: (messageId: string) => boolean;
  jumpMessage: string | undefined;
  onJumpMessageConsumed: (() => void) | undefined;
  /** Reads the window around a message; resolves to its whole id (a link may name a short one). */
  onLoadMessageAround: ((messageId: string) => Promise<string>) | undefined;
  setFollowingLatest: (following: boolean) => void;
  scrollToLatest: (behavior: ScrollBehavior) => void;
  bottomPin: ConversationBottomPin;
}): {
  showMessage: (messageId: string, options?: { opening?: boolean }) => Promise<void>;
  jumpHighlightId: string | undefined;
} {
  const toast = useAppToast();
  // What a jump told the viewer belongs to this conversation: leaving it takes the toast away, so
  // it is never left over another page.
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
  // The row a position jump just landed on, highlighted for a moment: `?message=` deliberately
  // carries no hash (#713), so the landed row has no `:target` to take the anchor highlight from
  // (message-row.tsx renders both treatments with the same classes).
  const [jumpHighlightId, setJumpHighlightId] = useState<string | undefined>(undefined);
  const jumpHighlightTimer = useRef<number | undefined>(undefined);
  const flashMessageRow = useCallback((messageId: string) => {
    setJumpHighlightId(messageId);
    window.clearTimeout(jumpHighlightTimer.current);
    jumpHighlightTimer.current = window.setTimeout(() => {
      setJumpHighlightId((current) => (current === messageId ? undefined : current));
    }, JUMP_HIGHLIGHT_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(jumpHighlightTimer.current), []);
  /** A jump scrolled `row` into view: its history's place is the reader's now, and a row that
   * landed at the bottom follows the latest from there (`ConversationBottomPin.landed`). */
  const landedOn = (row: Element) => {
    const history = row.closest<HTMLDivElement>("[data-scroll-restoration-id]");
    if (history && bottomPin.landed(history)) setFollowingLatest(true);
  };
  const revealSystemMessageRef = useRef(revealSystemMessage);
  revealSystemMessageRef.current = revealSystemMessage;

  // The hash a landing last highlighted: the anchor pass reruns as pages load, and re-scrolls, but
  // flashes a row once per link.
  const flashedAnchorRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    function scrollToMessageAnchor() {
      const anchor = window.location.hash.slice(1);
      if (!anchor.startsWith("message-")) return;
      // Every loaded row is in the DOM and in normal flow, so the anchored row's own box is the
      // only thing to measure — there is no estimate to settle on. The second pass covers the
      // router's own scroll restoration, which runs after this effect.
      const scroll = () => {
        const message = document.getElementById(anchor);
        if (!message) {
          // A notice folded into a system group: open the group, and let the pending-jump pass
          // below scroll to the row once it exists.
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
        // `:target` marks only a row that existed when the hash was set; a row the pane renders
        // later (any thread a link opens) would land unmarked, so the landing flashes it by id.
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
      // Loaded but folded into a system group: open it; this pass runs again once it is open.
      revealSystemMessage(messageId);
      return;
    }
    pendingMessageIdRef.current = undefined;
    scrollToMessageRow(messageId, landedOn);
    flashMessageRow(messageId);
  }, [messages, openedSystemMessages, flashMessageRow]);

  /** Scrolls to a message, loading the window around it first. `opening`: the conversation opens on
   * it, so a failed load leaves the pane at the latest instead. */
  async function showMessage(messageId: string, { opening = false } = {}) {
    const loaded = messages.some((message) => message.id === messageId);
    setFollowingLatest(false);
    if (!loaded) {
      if (!onLoadMessageAround) return;
      // A short id (a link's, #34) is the read's to resolve: until it answers, no row is the one.
      const whole = UUID_LIKE.test(messageId);
      if (whole) pendingMessageIdRef.current = messageId;
      try {
        const landed = await onLoadMessageAround(messageId);
        if (!whole) {
          // The window may already be drawn (land now) or not yet (the pending pass lands).
          if (document.getElementById(`message-${landed}`)) {
            scrollToMessageRow(landed, landedOn);
            flashMessageRow(landed);
          } else pendingMessageIdRef.current = landed;
        }
      } catch (error) {
        pendingMessageIdRef.current = undefined;
        tellJumpFailure(toast, error);
        // A conversation that was opening on the message opens at the latest instead.
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

  // The Saved view's `?message=<uuid>` jump (#127 follow-up) is position-only: it lands at the
  // message's row in the stream, never in its thread (the hash path above opens the thread). The
  // wrapper owns the router read, so this pane stays free of router hooks and the thread-root
  // tests can render it standalone. It is consumed once — the window around the anchor loads and
  // `showMessage` scrolls to it — then stripped like a hash, so a later navigation cannot inherit
  // it. A notification's hash wins outright; the rules are the pure `positionJumpDecision` table
  // (conversation-thread-search.ts), pinned by unit tests.
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
    // A jump from outside the pane: opening the conversation on a message, or another search
    // result or link into the conversation already open.
    if (decision.action === "show") void showMessageRef.current(decision.id, { opening: true });
    onJumpMessageConsumed?.();
  }, [jumpMessage, onJumpMessageConsumed]);

  return { showMessage, jumpHighlightId };
}
