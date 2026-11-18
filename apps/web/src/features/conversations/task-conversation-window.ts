import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import {
  CONVERSATION_WINDOW_PAGE_SIZE,
  type ConversationWindowCursor,
} from "#src/lib/conversation-window";
import { mergeMessages } from "./conversation-messages";
import { taskConversationQueryKey } from "./conversation-query-keys";
import { windowAround } from "./conversation-queries";
import { conversationPages } from "./conversation-window-query";
import { windowReadSettled } from "./conversation-window-reads";
import type { loadTaskConversation } from "./conversations.functions";

export type TaskPage = Awaited<ReturnType<typeof loadTaskConversation>>;
type TaskWindow = InfiniteData<TaskPage>;

export const TASK_WINDOW_START: ConversationWindowCursor = {
  after: 0,
  limit: CONVERSATION_WINDOW_PAGE_SIZE,
};

export function taskConversationWindow(
  conversationId: string | undefined,
  loadPage: Parameters<typeof conversationPages<TaskPage["messages"][number], TaskPage>>[1],
  {
    start = TASK_WINDOW_START,
    followingLatest = () => false,
  }: { start?: ConversationWindowCursor; followingLatest?: () => boolean } = {},
) {
  const { query, loadInitialPage } = conversationPages<TaskPage["messages"][number], TaskPage>(
    taskConversationQueryKey(conversationId),
    loadPage,
  );
  return {
    query: {
      ...query,
      initialPageParam: start,
      meta: { ...query.meta, conversationFollowingLatest: followingLatest },
    },
    loadInitialPage,
  };
}

export function taskWindowMessages(data: TaskWindow | undefined) {
  return (data?.pages ?? []).reduce<TaskPage["messages"]>(
    (all, page) => mergeMessages(all, page.messages),
    [],
  );
}

export async function catchUpTaskConversation(
  queryClient: QueryClient,
  id: string,
  readUpdates: (input: {
    conversationId: string;
    afterSequence: number;
  }) => Promise<TaskPage["messages"]>,
) {
  const key = taskConversationQueryKey(id);
  const held = queryClient.getQueryData<TaskWindow>(key)?.pages.at(-1);
  if (!held || held.hasNewer) return;
  const arrived = await readUpdates({
    conversationId: id,
    afterSequence: held.messages.at(-1)?.sequence ?? 0,
  });
  await windowReadSettled(queryClient, key);
  queryClient.setQueryData<TaskWindow>(key, (data) => {
    const newest = data?.pages.at(-1);
    if (!data || !newest || newest.hasNewer) return data;
    const last = newest.messages.at(-1)?.sequence ?? 0;
    const following = arrived.filter((message) => message.sequence > last);
    if (following.length === 0) return data;
    return {
      ...data,
      pages: [
        ...data.pages.slice(0, -1),
        { ...newest, messages: mergeMessages(newest.messages, following) },
      ],
    };
  });
}

export async function replaceTaskWindowAround<A extends Parameters<typeof windowAround>[1]>(
  queryClient: QueryClient,
  id: string,
  around: A,
) {
  const key = taskConversationQueryKey(id);
  await windowReadSettled(queryClient, key);
  queryClient.setQueryData<TaskWindow>(key, (data) => {
    const newest = data?.pages.at(-1);
    return data && newest ? (windowAround(newest, around) as TaskWindow) : data;
  });
}

export async function replaceTaskWindowWithNewest(
  queryClient: QueryClient,
  id: string,
  newest: TaskPage,
) {
  await windowReadSettled(queryClient, taskConversationQueryKey(id));
  queryClient.setQueryData<TaskWindow>(taskConversationQueryKey(id), {
    pages: [newest],
    pageParams: [undefined],
  });
}

export function withViewerSeat(
  data: TaskWindow | undefined,
  senderMemberId: TaskPage["senderMemberId"],
) {
  const newest = data?.pages.at(-1);
  return data && newest
    ? { ...data, pages: [...data.pages.slice(0, -1), { ...newest, senderMemberId }] }
    : data;
}

export function taskEventsBounds(
  messages: readonly { sequence: number }[],
  hasNewer: boolean,
): { oldestSequence?: number; newestSequence?: number } {
  const oldest = messages[0]?.sequence;
  const newest = messages.at(-1)?.sequence;
  return {
    ...(oldest ? { oldestSequence: oldest } : {}),
    ...(hasNewer && newest ? { newestSequence: newest } : {}),
  };
}
