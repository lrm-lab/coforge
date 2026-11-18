import { UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { mergeMessages } from "./conversation-messages";
import { taskConversationQueryKey } from "./conversation-query-keys";
import type { loadTaskConversation } from "./conversations.functions";

export type Page = Awaited<ReturnType<typeof loadTaskConversation>>;

/** How many older pages (50 messages each) a read back to one message may take. */
const BACK_PAGES = 5;
const WHOLE_ID = new RegExp(`^${UUID_LIKE_SOURCE}$`, "i");

/** One page in place of the newest, the rest kept. */
export function withNewest(data: InfiniteData<Page> | undefined, newest: (page: Page) => Page) {
  const [first, ...rest] = data?.pages ?? [];
  return data && first ? { ...data, pages: [newest(first), ...rest] } : data;
}

export async function catchUpTaskConversation(
  queryClient: QueryClient,
  id: string,
  readUpdates: (input: {
    conversationId: string;
    afterSequence: number;
  }) => Promise<Page["messages"]>,
) {
  const key = taskConversationQueryKey(id);
  const read = queryClient.getQueryData<InfiniteData<Page>>(key);
  if (!read) return;
  const after = read.pages[0]?.messages.at(-1)?.sequence ?? 0;
  const arrived = await readUpdates({ conversationId: id, afterSequence: after });
  queryClient.setQueryData<InfiniteData<Page>>(key, (data) =>
    withNewest(data, (page) => ({
      ...page,
      messages: mergeMessages(page.messages, arrived),
    })),
  );
}

export async function loadTaskBackTo({
  queryClient,
  conversationId,
  messageId,
  catchUp,
  fetchNextPage,
}: {
  queryClient: QueryClient;
  conversationId: string | undefined;
  messageId: string;
  catchUp: (id: string) => Promise<void>;
  fetchNextPage: () => Promise<{
    data: InfiniteData<Page> | undefined;
    hasNextPage: boolean;
    isError: boolean;
  }>;
}) {
  const held = (data: InfiniteData<Page> | undefined) =>
    data?.pages.some((page) => page.messages.some((message) => message.id === messageId));
  if (!WHOLE_ID.test(messageId)) throw new Error("message not found");
  const key = taskConversationQueryKey(conversationId);
  if (held(queryClient.getQueryData(key))) return messageId;
  if (conversationId) {
    await catchUp(conversationId);
    if (held(queryClient.getQueryData(key))) return messageId;
  }
  for (let page = 0; page < BACK_PAGES; page++) {
    const read = await fetchNextPage();
    if (held(read.data)) return messageId;
    if (!read.hasNextPage || read.isError) break;
  }
  throw new Error("message not found");
}
