import { expect, test } from "bun:test";
import { queryOptions } from "@tanstack/react-query";

import { createChatListReader } from "#src/features/conversations/chat-lists-reader";
import type { ChatListRead } from "#src/features/conversations/chat-list-reads";
import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import type { PersistedQueryStore } from "#src/features/cache-persistence/query-cache-persistence";
import {
  chatSectionOrderQuery,
  chatSectionsQuery,
} from "#src/features/conversations/chat-sections";
import { savedMessagesQueryKey } from "#src/features/conversations/saved-messages-collection";

import { memoryStore, pageLoad } from "./helpers/query-cache-harness";

const tasks = (count: number) =>
  Array.from({ length: count }).reduce<Promise<void>>(
    (before) => before.then(() => new Promise((resolve) => setTimeout(resolve, 0))),
    Promise.resolve(),
  );

function staggeredStore(store: PersistedQueryStore): PersistedQueryStore {
  let gets = 0;
  return {
    ...store,
    get: async (key) => {
      gets += 1;
      await tasks(gets * 3);
      return store.get(key);
    },
  };
}

const workspaceId = "ws-1";
const LISTS: [ChatListRead, readonly unknown[]][] = [
  ["channels", sidebarChannelsQueryKey(workspaceId)],
  ["directBadges", sidebarDirectsQueryKey(workspaceId)],
  ["channelNames", channelNamesQueryKey(workspaceId)],
  ["saved", savedMessagesQueryKey(workspaceId)],
  ["sections", chatSectionsQuery(workspaceId).queryKey],
  ["sectionOrder", chatSectionOrderQuery(workspaceId).queryKey],
];

test("Chat's lists started together go out in one read even when storage answers them tasks apart", async () => {
  const calls: ChatListRead[][] = [];
  const read = createChatListReader(
    async (lists) => {
      calls.push(lists);
      return Object.fromEntries(lists.map((list) => [list, { value: { rows: [] } }])) as never;
    },
    { workspace: () => workspaceId },
  );
  const { queryClient } = pageLoad(staggeredStore(memoryStore().store));

  await Promise.all(
    LISTS.map(([list, queryKey]) =>
      queryClient.fetchQuery(queryOptions({ queryKey, queryFn: () => read(list) })),
    ),
  );

  expect(calls).toHaveLength(1);
  expect([...calls[0]!].sort()).toEqual(LISTS.map(([list]) => list).sort());
});
