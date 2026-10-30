import type { NotifyOnChangeProps } from "@tanstack/react-query";

import type { ChatSection, ChatSectionSortMode } from "./chat-section.schemas";
import {
  createChatSection,
  updateChatSection,
  deleteChatSection,
  moveConversationToSection,
  reorderChatSections,
} from "./chat-sections.functions";
import { readChatList, type ChatListValue } from "./chat-lists-reader";

export type ChatSectionsApi = {
  /** The sections, with the stream position of the viewer's own signal channel, which announces
   * their changes (`pref.changed.v1`, `sections`). */
  list: () => Promise<ChatListValue<"sections">>;
  /** The sidebar's saved section order (`ChatSections.order`), with that position too. */
  order: () => Promise<ChatListValue<"sectionOrder">>;
  create: (input: { name: string; emoji: string | null }) => Promise<ChatSection>;
  update: (
    id: string,
    patch: {
      name?: string;
      emoji?: string | null;
      collapsed?: boolean;
      sortMode?: ChatSectionSortMode;
    },
  ) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  /** Custom section ids, with the built-in sections' keys when they moved too. */
  reorder: (order: readonly string[]) => Promise<unknown>;
  move: (
    conversationId: string,
    sectionId: string | null,
    beforeConversationId?: string | null,
  ) => Promise<unknown>;
};

export const serverChatSectionsApi: ChatSectionsApi = {
  list: () => readChatList("sections"),
  order: () => readChatList("sectionOrder"),
  create: (input) => createChatSection({ data: input }),
  update: (id, patch) => updateChatSection({ data: { id, patch } }),
  remove: (id) => deleteChatSection({ data: { id } }),
  reorder: (ids) => reorderChatSections({ data: { ids: [...ids] } }),
  move: (conversationId, sectionId, beforeConversationId) =>
    moveConversationToSection({ data: { conversationId, sectionId, beforeConversationId } }),
};

/** Like other personal lists, the QueryClient belongs to one signed-in viewer and is cleared
 * on sign-out. Kept live like the Chat lists: a change made on any page or device is announced on
 * the viewer's own signal channel and read again (`sidebarListsChangedBy`), and one a subscribe
 * may have missed is too (`listsMissedBySubscribe`); a returning tab does not read them. */
export const chatSectionsQuery = (workspaceId: string, api = serverChatSectionsApi) => ({
  queryKey: ["conversation", "sidebar", workspaceId, "sections"] as const,
  queryFn: api.list,
  refetchOnWindowFocus: false,
});

/** The sidebar's section order, saved per member; read with the sections. */
export const chatSectionOrderQuery = (workspaceId: string, api = serverChatSectionsApi) => ({
  queryKey: ["conversation", "sidebar", workspaceId, "section-order"] as const,
  queryFn: api.order,
  refetchOnWindowFocus: false,
  // A read that failed leaves the order invalidated, which holds every section drag back
  // (`chatSectionOrderReady`) until the next change is announced: it is tried again first, waiting
  // a little longer each time, and offline it waits for the network.
  retry: 3,
  // `chatSectionOrderReady` reads the invalidation flag, which is not on the result: a read starts
  // whenever the query is invalidated, so a view of it renders again when one starts or ends.
  notifyOnChangeProps: ["data", "status", "fetchStatus"] satisfies NotifyOnChangeProps,
});

/** Whether the sidebar has its sections to show. A re-read that fails keeps the sections already
 * shown (`ready`), as a failed re-read of a Chat list keeps its rows: the next change announced
 * reads them again, so it is not a failure to tell anyone about. Only a first read that failed is (`failed`). */
export function chatSectionsStatus(sections: {
  data: unknown;
  isLoadingError: boolean;
}): "loading" | "failed" | "ready" {
  if (sections.data !== undefined) return "ready";
  return sections.isLoadingError ? "failed" : "loading";
}

/** Whether the sections may be dragged: a drag saves the whole order, so it must start from the
 * order the server holds now. One restored from the browser copy, or invalidated by a save, is not
 * that until its own read succeeds; a drag from it could overwrite a reorder made elsewhere since. */
export const chatSectionOrderReady = (order: { status: string; isInvalidated: boolean }) =>
  order.status === "success" && !order.isInvalidated;
