import type { ChatSection } from "./chat-section.schemas";
import {
  listChatSections,
  createChatSection,
  updateChatSection,
  deleteChatSection,
  moveConversationToSection,
  reorderChatSections,
} from "./chat-sections.functions";

export type ChatSectionsApi = {
  list: () => Promise<ChatSection[]>;
  create: (input: { name: string; emoji: string | null }) => Promise<ChatSection>;
  update: (
    id: string,
    patch: { name?: string; emoji?: string | null; collapsed?: boolean },
  ) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  reorder: (ids: readonly string[]) => Promise<unknown>;
  move: (
    conversationId: string,
    sectionId: string | null,
    beforeConversationId?: string | null,
  ) => Promise<unknown>;
};

export const serverChatSectionsApi: ChatSectionsApi = {
  list: () => listChatSections(),
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
