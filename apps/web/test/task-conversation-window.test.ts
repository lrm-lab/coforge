import { describe, expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { taskConversationQueryKey } from "#src/features/conversations/conversation-query-keys";
import {
  catchUpTaskConversation,
  replaceTaskWindowAround,
  replaceTaskWindowWithNewest,
  taskConversationWindow,
  taskEventsBounds,
  TASK_WINDOW_START,
  type TaskPage,
} from "#src/features/conversations/task-conversation-window";
import type { ConversationWindowCursor } from "#src/lib/conversation-window";

type Message = TaskPage["messages"][number];
const id = "task-conv-1";
const key = taskConversationQueryKey(id);

const message = (sequence: number) =>
  ({
    id: `m${sequence}`,
    sequence,
    senderKind: "user",
    body: `reply ${sequence}`,
  }) as unknown as Message;

const page = (sequences: number[], flags: { hasOlder: boolean; hasNewer: boolean }) =>
  ({
    conversationId: id,
    senderMemberId: "seat",
    readThroughSequence: 0,
    ...flags,
    messages: sequences.map(message),
  }) as unknown as TaskPage;

const held = (queryClient: QueryClient) =>
  queryClient.getQueryData<InfiniteData<TaskPage, ConversationWindowCursor>>(key)!;

describe("the Task discussion's window", () => {
  test("opens at the oldest page: the first read goes forward from the start", async () => {
    const requests: unknown[] = [];
    const { query } = taskConversationWindow(id, async (request) => {
      requests.push(request);
      return page([1, 2], { hasOlder: false, hasNewer: true });
    });
    const queryClient = new QueryClient();
    await queryClient.fetchInfiniteQuery(query);
    expect(requests).toEqual([{ afterSequence: 0, beforeSequence: undefined, limit: 20 }]);
    expect(query.initialPageParam).toEqual(TASK_WINDOW_START);
  });

  test("has no older page at the start, and pages forward from the newest loaded message", async () => {
    const requests: unknown[] = [];
    const { query } = taskConversationWindow(id, async (request) => {
      requests.push(request);
      return request.afterSequence === 0
        ? page([1, 2], { hasOlder: false, hasNewer: true })
        : page([3], { hasOlder: true, hasNewer: false });
    });
    const first = page([1, 2], { hasOlder: false, hasNewer: true });
    expect(query.getPreviousPageParam!(first, [first], undefined, [undefined])).toBeUndefined();
    expect(query.getNextPageParam(first, [first], undefined, [undefined])).toEqual({ after: 2 });
    const queryClient = new QueryClient();
    await queryClient.fetchInfiniteQuery(query);
    await queryClient.fetchInfiniteQuery({ ...query, pages: 2 });
    expect(requests.at(-1)).toMatchObject({ afterSequence: 2 });
  });

  test("starts where a jump read, when there is one", () => {
    const start = { after: 9, limit: 41 };
    const { query } = taskConversationWindow(
      id,
      async () => page([], { hasOlder: false, hasNewer: false }),
      { start },
    );
    expect(query.initialPageParam).toBe(start);
  });
});

function held0(queryClient: QueryClient) {
  return held(queryClient).pages[0]!;
}

describe("catching up", () => {
  const seed = (queryClient: QueryClient, newest: TaskPage) =>
    queryClient.setQueryData<InfiniteData<TaskPage>>(key, {
      pages: [newest],
      pageParams: [undefined],
    });

  test("a window at the tail takes what arrived after its newest message", async () => {
    const queryClient = new QueryClient();
    seed(queryClient, page([1, 2], { hasOlder: false, hasNewer: false }));
    let after: number | undefined;
    await catchUpTaskConversation(queryClient, id, async (input) => {
      after = input.afterSequence;
      return [message(3)];
    });
    expect(after).toBe(2);
    expect(held0(queryClient).messages.map((m) => m.sequence)).toEqual([1, 2, 3]);
  });

  test("a window with newer messages reads nothing and takes nothing", async () => {
    const queryClient = new QueryClient();
    seed(queryClient, page([1, 2], { hasOlder: false, hasNewer: true }));
    let reads = 0;
    await catchUpTaskConversation(queryClient, id, async () => {
      reads += 1;
      return [message(3)];
    });
    expect(reads).toBe(0);
    expect(held0(queryClient).messages.map((m) => m.sequence)).toEqual([1, 2]);
  });

  test("an answer that finds the window replaced with a later page leaves no hole in it", async () => {
    const queryClient = new QueryClient();
    seed(queryClient, page([1, 2], { hasOlder: false, hasNewer: false }));
    await catchUpTaskConversation(queryClient, id, async () => {
      seed(queryClient, page([60, 61], { hasOlder: true, hasNewer: false }));
      return [message(3), message(61), message(62)];
    });
    expect(held0(queryClient).messages.map((m) => m.sequence)).toEqual([60, 61, 62]);
  });

  test("an answer that finds the window moved away is not written", async () => {
    const queryClient = new QueryClient();
    seed(queryClient, page([1, 2], { hasOlder: false, hasNewer: false }));
    await catchUpTaskConversation(queryClient, id, async () => {
      seed(queryClient, page([1, 2], { hasOlder: false, hasNewer: true }));
      return [message(3)];
    });
    expect(held0(queryClient).messages.map((m) => m.sequence)).toEqual([1, 2]);
  });
});

describe("replacing the window", () => {
  test("around a message: one page that a refetch reads from its first row", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<InfiniteData<TaskPage>>(key, {
      pages: [page([1, 2], { hasOlder: false, hasNewer: true })],
      pageParams: [TASK_WINDOW_START],
    });
    await replaceTaskWindowAround(queryClient, id, {
      messages: [message(30), message(31)],
      hasOlder: true,
      hasNewer: true,
    });
    const window = held(queryClient);
    expect(window.pages).toHaveLength(1);
    expect(window.pages[0]!.messages.map((m) => m.sequence)).toEqual([30, 31]);
    expect(window.pages[0]!.senderMemberId).toBe("seat");
    expect(window.pageParams).toEqual([{ after: 29, limit: 2 }]);
  });

  test("the newest page: a window at the tail that reads older pages from it", async () => {
    const queryClient = new QueryClient();
    await replaceTaskWindowWithNewest(
      queryClient,
      id,
      page([60, 61], { hasOlder: true, hasNewer: false }),
    );
    expect(held(queryClient).pageParams).toEqual([undefined]);
    expect(held0(queryClient).hasNewer).toBe(false);
  });
});

describe("the events a window reads", () => {
  const sequences = (...values: number[]) => values.map((sequence) => ({ sequence }));
  test("a window at the tail names only its oldest message", () => {
    expect(taskEventsBounds(sequences(1, 2, 3), false)).toEqual({ oldestSequence: 1 });
  });
  test("a window with newer messages names its oldest and newest", () => {
    expect(taskEventsBounds(sequences(21, 22, 40), true)).toEqual({
      oldestSequence: 21,
      newestSequence: 40,
    });
  });
  test("an empty conversation names neither", () => {
    expect(taskEventsBounds([], false)).toEqual({});
    expect(taskEventsBounds([], true)).toEqual({});
  });
});
