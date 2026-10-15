import type { ChatSection, ChatSectionSortMode } from "./chat-section.schemas";
import {
  listChatSections,
  createChatSection,
  updateChatSection,
  deleteChatSection,
  moveConversationToSection,
  reorderChatSections,
  getChatSectionOrder,
} from "./chat-sections.functions";

export type ChatSectionsApi = {
  list: () => Promise<ChatSection[]>;
  /** The sidebar's saved section order (`ChatSections.order`). */
  order: () => Promise<string[]>;
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
  list: () => listChatSections(),
  order: () => getChatSectionOrder(),
  create: (input) => createChatSection({ data: input }),
  update: (id, patch) => updateChatSection({ data: { id, patch } }),
  remove: (id) => deleteChatSection({ data: { id } }),
  reorder: (ids) => reorderChatSections({ data: { ids: [...ids] } }),
  move: (conversationId, sectionId, beforeConversationId) =>
    moveConversationToSection({ data: { conversationId, sectionId, beforeConversationId } }),
};

/** Like other personal lists, the QueryClient belongs to one signed-in viewer and is cleared
 * on sign-out. Refetch on focus and every 30s in a visible tab keeps other devices current. */
export const chatSectionsQuery = (workspaceId: string, api = serverChatSectionsApi) => ({
  queryKey: ["conversation", "sidebar", workspaceId, "sections"] as const,
  queryFn: api.list,
  refetchOnWindowFocus: "always" as const,
  refetchInterval: 30_000,
});

/** The sidebar's section order, saved per member; read with the sections. */
export const chatSectionOrderQuery = (workspaceId: string, api = serverChatSectionsApi) => ({
  queryKey: ["conversation", "sidebar", workspaceId, "section-order"] as const,
  queryFn: api.order,
  refetchOnWindowFocus: "always" as const,
  refetchInterval: 30_000,
});
