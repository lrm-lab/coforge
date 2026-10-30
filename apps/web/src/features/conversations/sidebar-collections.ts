import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { createCollection, createOptimisticAction } from "@tanstack/react-db";
import type { PendingMutation, Transaction } from "@tanstack/react-db";
import {
  queryCollectionOptions,
  UpdateOperationItemNotFoundError,
} from "@tanstack/query-db-collection";

import { assertBrowserOnly } from "#src/lib/browser-only";
import { nextPinOrder, pinOrdersAfterArrange } from "#src/lib/pin-order";
import { sidebarChannelsQueryKey, sidebarDirectsQueryKey } from "./conversation-query-keys";
import {
  channelRowKey,
  directRowKey,
  pinOfRowKey,
  rowKeyOf,
  type PinRef,
} from "./pinned-conversations";
import type { DirectRow } from "./sidebar-rows";
import type { ChannelSignal } from "./channel-signals";
import { createSaveRetries } from "./sidebar-save-retries";
import type { ChatListValue } from "./chat-lists-reader";
import { chatSectionOrderQuery, chatSectionsQuery, type ChatSectionsApi } from "./chat-sections";
import { isBuiltInSection } from "./directory-section-order";
import type { ChatSection } from "./chat-section.schemas";
import {
  fetchChannels,
  fetchDirects,
  LIST_OPTIONS,
  serverSidebarApi,
  type Arrangement,
  type ChannelRow,
  type SidebarApi,
} from "./sidebar-queries";

// The Chat sidebar's channel and DM lists as TanStack DB collections, and the changes made to them
// from the sidebar. How they fit with the Query cache and SSR: `features/conversations/AGENTS.md`.

/** The fields of a row that a sidebar change touches, named alike on channel and DM rows. */
type SidebarFields = {
  pinned: boolean;
  pinSortOrder: number | null;
  unreadCount: number;
  hidden: boolean;
  muted?: boolean;
};

/**
 * The sidebar's two collections, over the same Query keys the loader fills, and the changes a
 * member makes from the sidebar. Each change shows at once and resolves when saved; it rejects
 * when the save failed, by which time the rows are back as they were.
 */
export function createSidebar(
  queryClient: QueryClient,
  workspaceId: string,
  api: SidebarApi = serverSidebarApi,
  retryOptions?: Parameters<typeof createSaveRetries>[0],
) {
  assertBrowserOnly("The Chat sidebar's collections");
  const { withRetries, savesRetrying } = createSaveRetries(retryOptions);
  /** The section saves that set a state outright, so saving one twice is saving it once: those
   * are retried. Creating a section is not (a retry could make two), nor removing one. */
  const sectionSaves = {
    update: (id: string, patch: Parameters<ChatSectionsApi["update"]>[1]) =>
      withRetries(`update:${id}:${Object.keys(patch).sort().join()}`, () =>
        api.sections.update(id, patch),
      ),
    reorder: (order: readonly string[]) =>
      withRetries("reorder", () => api.sections.reorder(order)),
    move: (...args: Parameters<ChatSectionsApi["move"]>) =>
      withRetries(`move:${args[0]}`, () => api.sections.move(...args)),
  };
  const channels = createCollection(
    queryCollectionOptions({
      id: `sidebar-channels:${workspaceId}`,
      queryKey: sidebarChannelsQueryKey(workspaceId),
      queryFn: fetchChannels(api),
      queryClient,
      getKey: (row: ChannelRow) => row.id,
      select: (data) => data.rows,
      ...LIST_OPTIONS,
    }),
  );
  const directs = createCollection(
    queryCollectionOptions({
      id: `sidebar-directs:${workspaceId}`,
      queryKey: sidebarDirectsQueryKey(workspaceId),
      queryFn: fetchDirects(api, { tolerant: false }),
      queryClient,
      getKey: (row: DirectRow) => row.conversationId,
      select: (data) => data.rows,
      ...LIST_OPTIONS,
    }),
  );
  const sections = createCollection(
    queryCollectionOptions({
      id: `chat-sections:${workspaceId}`,
      ...chatSectionsQuery(workspaceId, api.sections),
      queryFn: api.sections.list,
      queryClient,
      getKey: (section: ChatSection) => section.id,
      select: (read) => read.sections,
    }),
  );

  /** Changes one row on screen; a row that has left the list meanwhile is left alone. */
  const edit = (target: PinRef, change: (row: SidebarFields) => void) => {
    if (target.kind === "channel") {
      if (channels.has(target.channelId)) channels.update(target.channelId, change);
    } else if (directs.has(target.conversationId)) directs.update(target.conversationId, change);
  };
  /** Keeps a saved change as shown: its fields are written into the synced list, so it does not
   * depend on a later re-read. A row the list has dropped meanwhile has nothing to keep. */
  const confirm = (transaction: Transaction) => {
    const write = (mutation: PendingMutation) => {
      const key = String(mutation.key);
      if (mutation.collection.id === sections.id) {
        if (mutation.type === "delete") sections.utils.writeDelete(key);
        else sections.utils.writeUpdate({ ...mutation.changes, id: key });
      } else if (mutation.collection.id === channels.id)
        channels.utils.writeUpdate({ ...mutation.changes, id: key });
      else directs.utils.writeUpdate({ ...mutation.changes, conversationId: key });
    };
    for (const mutation of transaction.mutations) {
      try {
        write(mutation);
      } catch (error) {
        // The row is no longer in the synced list: the next read shows the list as it is.
        if (!(error instanceof UpdateOperationItemNotFoundError)) throw error;
      }
    }
  };
  const allPinOrders = () =>
    [...channels.toArray, ...directs.toArray].map((row) => (row.pinned ? row.pinSortOrder : null));
  const reread = (target: PinRef) =>
    void (target.kind === "channel" ? channels.utils.refetch() : directs.utils.refetch());

  const pin = createOptimisticAction<{ target: PinRef; pinned: boolean }>({
    onMutate: ({ target, pinned }) => {
      const order = nextPinOrder(allPinOrders());
      edit(target, (row) => {
        if (row.pinned === pinned) return;
        row.pinned = pinned;
        row.pinSortOrder = pinned ? order : null;
      });
    },
    mutationFn: async ({ target, pinned }, { transaction }) => {
      await api.pin(target, pinned);
      confirm(transaction);
    },
  });

  const setMutedAtOnce = createOptimisticAction<{ target: PinRef; muted: boolean }>({
    onMutate: ({ target, muted }) =>
      edit(target, (row) => {
        row.muted = muted;
      }),
    mutationFn: async ({ target, muted }, { transaction }) => {
      await api.setMuted(target, muted);
      confirm(transaction);
    },
  });

  // The badge shows at least one at once; the re-read afterwards brings the server's count, which
  // stays zero when only the viewer has spoken.
  const markUnreadAtOnce = createOptimisticAction<PinRef>({
    onMutate: (target) =>
      edit(target, (row) => {
        row.unreadCount = Math.max(1, row.unreadCount);
      }),
    mutationFn: async (target, { transaction }) => {
      await api.markUnread(target);
      confirm(transaction);
      reread(target);
    },
  });

  const setHiddenAtOnce = createOptimisticAction<{ target: PinRef; hidden: boolean }>({
    onMutate: ({ target, hidden }) =>
      edit(target, (row) => {
        row.hidden = hidden;
      }),
    mutationFn: async ({ target, hidden }, { transaction }) => {
      await api.setHidden(target, hidden);
      confirm(transaction);
    },
  });
  const setHidden = (target: PinRef, hidden: boolean) =>
    saved(setHiddenAtOnce({ target, hidden }), () => api.setHidden(target, hidden), listOf(target));

  const updateSection = createOptimisticAction<{
    id: string;
    patch: Parameters<ChatSectionsApi["update"]>[1];
  }>({
    onMutate: ({ id, patch }) => {
      if (sections.has(id)) sections.update(id, (section) => Object.assign(section, patch));
    },
    mutationFn: async ({ id, patch }, { transaction }) => {
      if (await sectionSaves.update(id, patch)) confirm(transaction);
    },
  });
  const removeSection = createOptimisticAction<string>({
    onMutate: (id) => {
      if (sections.has(id)) sections.delete(id);
    },
    mutationFn: async (id, { transaction }) => {
      await api.sections.remove(id);
      confirm(transaction);
    },
  });
  const reorderSections = createOptimisticAction<readonly string[]>({
    onMutate: (order) => {
      const ids = order.filter((key) => !isBuiltInSection(key));
      const current = [...sections.toArray].sort((a, b) => a.sortOrder - b.sortOrder);
      const sorted = [
        ...ids,
        ...current.map((section) => section.id).filter((id) => !ids.includes(id)),
      ];
      sorted.forEach((id, sortOrder) => {
        if (sections.has(id))
          sections.update(id, (section) => {
            section.sortOrder = sortOrder;
          });
      });
    },
    mutationFn: async (order, { transaction }) => {
      if (await sectionSaves.reorder(order)) confirm(transaction);
    },
  });
  const moveToSection = createOptimisticAction<{
    target: PinRef;
    sectionId: string | null;
    beforeConversationId?: string | null;
  }>({
    onMutate: ({ target, sectionId, beforeConversationId }) => {
      const conversationId = target.kind === "channel" ? target.channelId : target.conversationId;
      for (const section of sections.toArray) {
        if (section.id !== sectionId && !section.conversationIds.includes(conversationId)) continue;
        sections.update(section.id, (draft) => {
          draft.conversationIds = draft.conversationIds.filter((id) => id !== conversationId);
          if (section.id === sectionId) {
            const index = beforeConversationId
              ? draft.conversationIds.indexOf(beforeConversationId)
              : -1;
            draft.conversationIds.splice(
              index < 0 ? draft.conversationIds.length : index,
              0,
              conversationId,
            );
            draft.collapsed = false;
          }
        });
      }
      edit(target, (row) => {
        row.pinned = false;
        row.pinSortOrder = null;
        row.hidden = false;
      });
    },
    mutationFn: async ({ target, sectionId, beforeConversationId }, { transaction }) => {
      const saved = await sectionSaves.move(
        target.kind === "channel" ? target.channelId : target.conversationId,
        sectionId,
        beforeConversationId,
      );
      if (saved) confirm(transaction);
    },
  });

  // Drags are saved one after another, in the order they were made: two saves in flight could
  // otherwise reach the server in either order and the older layout win.
  let arranging: Promise<unknown> = Promise.resolve();
  const arrange = createOptimisticAction<Arrangement>({
    onMutate: (arrangement) => {
      const pinned = [
        ...channels.toArray.flatMap((row) =>
          row.pinned ? [{ key: channelRowKey(row.id), row }] : [],
        ),
        ...directs.toArray.flatMap((row) =>
          row.pinned ? [{ key: directRowKey(row.conversationId), row }] : [],
        ),
      ];
      const orders = pinOrdersAfterArrange(
        pinned.map(({ key, row }) => ({ key, order: row.pinSortOrder ?? 0 })),
        { pins: arrangement.pins.map(rowKeyOf), unpinned: arrangement.unpinned.map(rowKeyOf) },
      );
      for (const [key, order] of orders)
        edit(pinOfRowKey(key), (row) => {
          if (row.pinSortOrder === order && row.pinned === (order !== null)) return;
          row.pinned = order !== null;
          row.pinSortOrder = order;
        });
    },
    mutationFn: async (arrangement, { transaction }) => {
      await saveArrangement(arrangement);
      confirm(transaction);
    },
  });
  function saveArrangement(arrangement: Arrangement) {
    const save = arranging.then(() => api.arrange(arrangement));
    arranging = save.catch(() => undefined);
    return save;
  }

  /** Settles when the change is saved. A change with nothing to show first (the lists have not
   * loaded on this page, the row has left them, or it already shows the change) makes an empty
   * transaction, which TanStack DB never saves: that one goes straight to the server, and the
   * lists it touches are marked stale, so the next page to show them reads them again. */
  const saved = (
    transaction: Transaction,
    save: () => Promise<unknown>,
    stale: readonly QueryKey[],
  ) =>
    (transaction.mutations.length > 0
      ? pending(transaction.isPersisted.promise)
      : save().then(() => {
          for (const queryKey of stale) void queryClient.invalidateQueries({ queryKey });
        })
    ).then(() => {});
  /** Changes shown but not yet saved. A failed save's rollback also undoes any direct write made
   * to the lists meanwhile, so `applyChannelSignal` does not write while one is pending. */
  let unsaved = 0;
  const pending = (persisted: Promise<unknown>) => {
    unsaved += 1;
    return persisted.finally(() => {
      unsaved -= 1;
    });
  };
  const channelsKey = sidebarChannelsQueryKey(workspaceId);
  const directsKey = sidebarDirectsQueryKey(workspaceId);
  const listOf = (target: PinRef) => [target.kind === "channel" ? channelsKey : directsKey];
  /** The order of the latest section drag, which the order query shows until the server's. */
  let newestOrder: readonly string[] | undefined;
  const orderKey = chatSectionOrderQuery(workspaceId).queryKey;
  /** Shows `order` in the order query; only a server read changes the positions it was read at. */
  const showOrder = (order: readonly string[]) =>
    queryClient.setQueryData<ChatListValue<"sectionOrder">>(orderKey, (read) => ({
      streamPositions: read?.streamPositions ?? {},
      order: [...order],
    }));
  const actions = {
    /** `order` is the whole sidebar (built-in keys and custom ids): the custom sections move in
     * the synced list, the built-in ones in the order query, which a failed save puts back. */
    reorderSections: async (order: readonly string[]) => {
      // A read already in flight would land after this and put the old order back. Cancelled
      // without `revert`, which would restore the pre-read state over the order set below.
      void queryClient.cancelQueries({ queryKey: orderKey, exact: true }, { revert: false });
      // Never read (or the read failed): the sidebar showed the default order, which `[]` is.
      const before = queryClient.getQueryData<ChatListValue<"sectionOrder">>(orderKey)?.order ?? [];
      showOrder(order);
      newestOrder = order;
      try {
        await saved(reorderSections(order), () => sectionSaves.reorder(order), [
          chatSectionsQuery(workspaceId).queryKey,
        ]);
        // A read that started during the save may have brought the old order back meanwhile. A
        // newer drag's order stands over this one's, whichever settles first.
        if (newestOrder === order) showOrder(order);
      } catch (cause) {
        if (newestOrder === order) showOrder(before);
        throw cause;
      } finally {
        // Either way the server now holds the truth; read it rather than trust this tab's copy.
        void queryClient.invalidateQueries({ queryKey: orderKey, exact: true });
      }
    },
    createSection: async (input: Parameters<ChatSectionsApi["create"]>[0]) => {
      const section = await api.sections.create(input);
      sections.utils.writeInsert(section);
      return section;
    },
    updateSection: (id: string, patch: Parameters<ChatSectionsApi["update"]>[1]) =>
      saved(updateSection({ id, patch }), () => sectionSaves.update(id, patch), [
        chatSectionsQuery(workspaceId).queryKey,
      ]),
    removeSection: (id: string) =>
      saved(removeSection(id), () => api.sections.remove(id), [
        chatSectionsQuery(workspaceId).queryKey,
      ]),
    moveToSection: (
      target: PinRef,
      sectionId: string | null,
      beforeConversationId?: string | null,
    ) =>
      saved(
        moveToSection({ target, sectionId, beforeConversationId }),
        () =>
          sectionSaves.move(
            target.kind === "channel" ? target.channelId : target.conversationId,
            sectionId,
            beforeConversationId,
          ),
        [chatSectionsQuery(workspaceId).queryKey, ...listOf(target)],
      ),
    setPinned: (target: PinRef, pinned: boolean) =>
      saved(pin({ target, pinned }), () => api.pin(target, pinned), listOf(target)),
    setMuted: (target: PinRef, muted: boolean) =>
      saved(setMutedAtOnce({ target, muted }), () => api.setMuted(target, muted), listOf(target)),
    markUnread: (target: PinRef) =>
      saved(markUnreadAtOnce(target), () => api.markUnread(target), listOf(target)),
    close: (target: PinRef) => setHidden(target, true),
    reopen: (target: PinRef) => setHidden(target, false),
    arrange: (arrangement: Arrangement) =>
      saved(arrange(arrangement), () => saveArrangement(arrangement), [channelsKey, directsKey]),
  };
  /**
   * Applies a channel created, changed or gone anywhere in the Workspace to the synced list, with
   * no read: a new channel is listed as one the viewer has not joined (their own join arrives as
   * a `ViewerEvent`), and a changed one takes its new name and archived state and keeps the
   * viewer's place in it. False when the list cannot place it and must be read again: it has not
   * synced yet, a sidebar change is still being saved (whose rollback, if the save fails, would
   * undo a direct write too), the event names only ids, or it is a channel the list has never
   * heard of coming back (`#general` restored, whose place for the viewer the event does not
   * carry). `known`: every channel's name has it, so a channel the list leaves out on purpose
   * (closed) stays out.
   */
  const applyChannelSignal = (signal: ChannelSignal, { known }: { known: boolean }): boolean => {
    if (channels.status !== "ready" || unsaved > 0) return false;
    const id = signal.conversationId;
    if (signal.type === "channel.updated.v1" && signal.gone) {
      if (channels.has(id)) channels.utils.writeDelete(id);
      return true;
    }
    if (!signal.channel) return false;
    const { name, archived } = signal.channel;
    if (channels.has(id)) channels.utils.writeUpdate({ id, name, archived });
    else if (signal.type === "channel.created.v1")
      channels.utils.writeInsert({
        id,
        name,
        joined: false,
        archived,
        muted: false,
        unreadCount: 0,
        mentioned: false,
        lastMessage: null,
        members: [],
        hidden: false,
        pinned: false,
        pinSortOrder: null,
      });
    else return known;
    return true;
  };

  return { channels, directs, sections, actions, applyChannelSignal, savesRetrying };
}

export type Sidebar = ReturnType<typeof createSidebar>;

// The reads live in `sidebar-queries.ts`; every caller reaches the sidebar through this module, so
// its names stay here.
export {
  channelNamesBehind,
  chatListQueryKey,
  chatListStaleTime,
  fetchChannels,
  fetchDirects,
  LIST_OPTIONS,
  listReadPosition,
  loadSidebarLists,
  serverSidebarApi,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type Arrangement,
  type ChannelRow,
  type SidebarApi,
} from "./sidebar-queries";
