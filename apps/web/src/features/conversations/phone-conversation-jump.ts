export const CLOSE_CHAT_LIST_EVENT = "coforge:close-chat-list";

export type ConversationLocationSnapshot = {
  pathname: string;
  search: Record<string, unknown>;
  hash: string;
};

export const CONVERSATION_REVEAL_SEARCH_KEYS = [
  "message",
  "threadRootId",
  "task",
  "doc",
  "profile",
  "details",
  "file",
] as const;

export function requestCloseChatList(): void {
  if (typeof document !== "undefined") {
    document.dispatchEvent(new Event(CLOSE_CHAT_LIST_EVENT));
  }
}

export function snapshotConversationLocation(location: {
  pathname: string;
  search: unknown;
  hash: string;
}): ConversationLocationSnapshot {
  return {
    pathname: location.pathname,
    search:
      location.search && typeof location.search === "object"
        ? (location.search as Record<string, unknown>)
        : {},
    hash: location.hash,
  };
}

export function navigationRevealsConversation(
  previous: ConversationLocationSnapshot,
  next: ConversationLocationSnapshot,
): boolean {
  if (next.pathname !== previous.pathname) return true;
  if (next.hash !== previous.hash && next.hash.length > 0) return true;
  for (const key of CONVERSATION_REVEAL_SEARCH_KEYS) {
    const value = next.search[key];
    if (value !== previous.search[key] && value !== undefined && value !== "") return true;
  }
  return false;
}

export function subscribeConversationReveal(
  router: {
    state: { location: { pathname: string; search: unknown; hash: string } };
    subscribe: (event: "onResolved", fn: () => void) => () => void;
  },
  onReveal: () => void,
): () => void {
  let previous = snapshotConversationLocation(router.state.location);
  const unsubscribe = router.subscribe("onResolved", () => {
    const next = snapshotConversationLocation(router.state.location);
    const reveals = navigationRevealsConversation(previous, next);
    previous = next;
    if (reveals) onReveal();
  });
  if (typeof document === "undefined") return unsubscribe;
  document.addEventListener(CLOSE_CHAT_LIST_EVENT, onReveal);
  return () => {
    unsubscribe();
    document.removeEventListener(CLOSE_CHAT_LIST_EVENT, onReveal);
  };
}
