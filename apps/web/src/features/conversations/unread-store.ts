import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

import { clearUnread, type UnreadCounts } from "./conversation-unread";
import { listChannelThreadUnreads } from "./channel-threads.functions";
import { createThreadUnreadRefresh, type ThreadUnreadRow } from "./thread-unread-refresh";
import { KeyedListeners } from "./keyed-listeners";

/**
 * The Chat page's unread counts by conversation id (with each one's read boundary, `<id>:seq`),
 * kept outside React state. A reader subscribes to the one count it shows (`useUnreadCount`), so a
 * message in one conversation renders that conversation's row alone; the open conversation only
 * clears its own (`useMarkConversationSeen`) and renders for none. The store never changes
 * identity, so the context that hands it out never renders anyone.
 */
export class UnreadStore {
  #counts: UnreadCounts = {};
  readonly #listeners = new KeyedListeners();
  readonly #threadRows = new Map<string, ThreadUnreadRow>();
  readonly #threadListeners = new KeyedListeners();
  #threadChannelIds = new Set<string>();
  #workspaceId?: string;

  readonly #threadRefresh = createThreadUnreadRefresh({
    read: async (workspaceId, conversationIds) =>
      (
        await listChannelThreadUnreads({
          data: { workspaceId, conversationIds: [...conversationIds] },
        })
      ).channels,
    apply: (_, rows) => {
      for (const row of rows) {
        const id = row.conversationId;
        if (!this.#threadChannelIds.has(id)) continue;
        const current = this.#threadRows.get(id);
        if (
          current?.unreadThreadCount === row.unreadThreadCount &&
          current.threadMentioned === row.threadMentioned
        )
          continue;
        this.#threadRows.set(id, row);
        this.#threadListeners.notify(id);
      }
    },
  });

  setThreadWorkspace(workspaceId: string | undefined) {
    if (workspaceId === this.#workspaceId) return;
    this.#workspaceId = workspaceId;
    this.#threadRefresh.setWorkspace(workspaceId);
    this.setThreadChannels([]);
  }

  setThreadChannels(ids: readonly string[]) {
    const previous = this.#threadChannelIds;
    this.#threadChannelIds = new Set(ids);
    for (const id of previous) {
      if (!this.#threadChannelIds.has(id) && this.#threadRows.delete(id))
        this.#threadListeners.notify(id);
    }
    for (const id of ids) {
      if (!previous.has(id)) this.invalidateThreadUnread(this.#workspaceId, id);
    }
  }

  readonly invalidateThreadUnread = (workspaceId: string | undefined, channelId: string) => {
    if (workspaceId && this.#threadChannelIds.has(channelId))
      this.#threadRefresh.invalidate(workspaceId, channelId);
  };

  refreshThreadUnreads() {
    for (const id of this.#threadChannelIds) this.invalidateThreadUnread(this.#workspaceId, id);
  }

  threadUnread(channelId: string) {
    return this.#threadRows.get(channelId);
  }

  subscribeThreadUnread(channelId: string, listener: () => void) {
    return this.#threadListeners.add(channelId, listener);
  }

  count(conversationId: string): number | undefined {
    return this.#counts[conversationId];
  }

  /** Applies `change` to the counts, and tells the readers of each count it moved. */
  update(change: (current: UnreadCounts) => UnreadCounts) {
    const previous = this.#counts;
    const next = change(previous);
    if (next === previous) return;
    this.#counts = next;
    for (const conversationId of this.#listeners.keys())
      if (previous[conversationId] !== next[conversationId]) this.#listeners.notify(conversationId);
  }

  /** Clears one conversation's badge and records the sequence it was read through. */
  readonly clear = (conversationId: string, readThroughSequence?: number) =>
    this.update((current) => clearUnread(current, conversationId, readThroughSequence));

  subscribe(conversationId: string, listener: () => void) {
    return this.#listeners.add(conversationId, listener);
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

export function useThreadUnread(channelId: string) {
  const store = useContext(UnreadStoreContext);
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribeThreadUnread(channelId, listener) ?? (() => {}),
    [store, channelId],
  );
  const read = () => store?.threadUnread(channelId);
  return useSyncExternalStore(subscribe, read, read);
}
