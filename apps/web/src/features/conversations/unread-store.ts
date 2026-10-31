import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { clearUnread, type UnreadCounts } from "./conversation-unread";

/**
 * The Chat page's unread counts by conversation id (with each one's read boundary, `<id>:seq`),
 * kept outside React state. A reader subscribes to the one count it shows (`useUnreadCount`), so a
 * message in one conversation renders that conversation's row alone; the open conversation only
 * clears its own (`useMarkConversationSeen`) and renders for none. The store never changes
 * identity, so the context that hands it out never renders anyone.
 */
export class UnreadStore {
  #counts: UnreadCounts = {};
  readonly #listeners = new Map<string, Set<() => void>>();

  count(conversationId: string): number | undefined {
    return this.#counts[conversationId];
  }

  /** Applies `change` to the counts, and tells the readers of each count it moved. */
  update(change: (current: UnreadCounts) => UnreadCounts) {
    const previous = this.#counts;
    const next = change(previous);
    if (next === previous) return;
    this.#counts = next;
    for (const [conversationId, listeners] of this.#listeners)
      if (previous[conversationId] !== next[conversationId])
        for (const listener of listeners) listener();
  }

  /** Clears one conversation's badge and records the sequence it was read through. */
  readonly clear = (conversationId: string, readThroughSequence?: number) =>
    this.update((current) => clearUnread(current, conversationId, readThroughSequence));

  subscribe(conversationId: string, listener: () => void) {
    let listeners = this.#listeners.get(conversationId);
    if (!listeners) this.#listeners.set(conversationId, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#listeners.get(conversationId) === listeners)
        this.#listeners.delete(conversationId);
    };
  }
}

/** The Chat page's store. A conversation opened outside it (Activity, search) has none: it shows
 * no count and has no badge to clear. */
export const UnreadStoreContext = createContext<UnreadStore | null>(null);

/** One conversation's live unread count, seeded from the loader and updated by realtime. */
export function useUnreadCount(conversationId: string): number | undefined {
  const store = useContext(UnreadStoreContext);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(conversationId, listener) ?? (() => {}),
    [store, conversationId],
  );
  const read = () => store?.count(conversationId);
  return useSyncExternalStore(subscribe, read, read);
}

/** Marks a conversation seen: clears its badge immediately and records the read boundary. */
export function useMarkConversationSeen(): UnreadStore["clear"] {
  return useContext(UnreadStoreContext)?.clear ?? clearNothing;
}

function clearNothing() {}
