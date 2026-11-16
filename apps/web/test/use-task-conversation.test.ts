import { describe, expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { taskConversationQueryKey } from "#src/features/conversations/conversation-query-keys";
import { loadTaskConversation } from "#src/features/conversations/conversations.functions";
import {
  catchUpTaskConversation,
  loadTaskBackTo,
} from "#src/features/conversations/use-task-conversation";

type Page = Awaited<ReturnType<typeof loadTaskConversation>>;
type Message = Page["messages"][number];

const uuidFor = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function makeMessage(sequence: number): Message {
  return {
    id: uuidFor(sequence),
    sequence,
    senderKind: "user",
    senderName: "Frank",
    body: `reply ${sequence}`,
    createdAt: "2026-11-16T12:00:00.000Z",
    attachments: [],
    mentions: [],
    forwards: [],
    reactions: [],
    tasks: [],
  } as unknown as Message;
}

function makePage(messages: Message[], hasOlder = false): Page {
  return {
    conversationId: "task-conv-1",
    senderMemberId: "member-1",
    readThroughSequence: messages.at(-1)?.sequence ?? 0,
    hasOlder,
    messages,
  } as unknown as Page;
}

describe("loadTaskBackTo (task #122)", () => {
  test("reopening on cached pages catches up newer replies before paging back, avoiding false load error", async () => {
    const queryClient = new QueryClient();
    const conversationId = "task-conv-1";
    const key = taskConversationQueryKey(conversationId);
    queryClient.setQueryData<InfiniteData<Page>>(key, {
      pages: [makePage([makeMessage(1), makeMessage(2)], false)],
      pageParams: [undefined],
    });

    const newerReply = makeMessage(3);
    let afterQueried: number | undefined;
    let pagedBackCount = 0;

    const resolvedId = await loadTaskBackTo({
      queryClient,
      conversationId,
      messageId: newerReply.id,
      catchUp: (id) =>
        catchUpTaskConversation(queryClient, id, async ({ afterSequence }) => {
          afterQueried = afterSequence;
          return [newerReply];
        }),
      fetchNextPage: async () => {
        pagedBackCount += 1;
        return { data: queryClient.getQueryData(key), hasNextPage: false, isError: false };
      },
    });

    expect(resolvedId).toBe(newerReply.id);
    expect(afterQueried).toBe(2);
    expect(pagedBackCount).toBe(0);
    const heldIds = queryClient
      .getQueryData<InfiniteData<Page>>(key)
      ?.pages[0]?.messages.map((m) => m.id);
    expect(heldIds).toEqual([uuidFor(1), uuidFor(2), newerReply.id]);
  });

  test("falls back to paging older history when the target predates the cached newest page", async () => {
    const queryClient = new QueryClient();
    const conversationId = "task-conv-1";
    const key = taskConversationQueryKey(conversationId);
    const olderReply = makeMessage(1);
    queryClient.setQueryData<InfiniteData<Page>>(key, {
      pages: [makePage([makeMessage(5), makeMessage(6)], true)],
      pageParams: [undefined],
    });

    let pagedBackCount = 0;
    const resolvedId = await loadTaskBackTo({
      queryClient,
      conversationId,
      messageId: olderReply.id,
      catchUp: (id) => catchUpTaskConversation(queryClient, id, async () => []),
      fetchNextPage: async () => {
        pagedBackCount += 1;
        const next: InfiniteData<Page> = {
          pages: [
            makePage([makeMessage(5), makeMessage(6)], true),
            makePage([olderReply, makeMessage(2)], false),
          ],
          pageParams: [undefined, 5],
        };
        queryClient.setQueryData(key, next);
        return { data: next, hasNextPage: false, isError: false };
      },
    });

    expect(resolvedId).toBe(olderReply.id);
    expect(pagedBackCount).toBe(1);
  });

  test("still throws when neither catch-up nor older pages hold the message so genuine load failures surface", async () => {
    const queryClient = new QueryClient();
    const conversationId = "task-conv-1";
    const key = taskConversationQueryKey(conversationId);
    queryClient.setQueryData<InfiniteData<Page>>(key, {
      pages: [makePage([makeMessage(1)], true)],
      pageParams: [undefined],
    });

    await expect(
      loadTaskBackTo({
        queryClient,
        conversationId,
        messageId: uuidFor(99),
        catchUp: async () => {},
        fetchNextPage: async () => ({
          data: queryClient.getQueryData(key),
          hasNextPage: true,
          isError: true,
        }),
      }),
    ).rejects.toThrow("message not found");
  });
});
