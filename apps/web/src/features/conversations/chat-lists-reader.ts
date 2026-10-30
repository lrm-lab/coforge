import { AppError } from "#src/lib/app-error";
import type { ChatListRead } from "./chat-list-reads";
import { loadChatLists } from "./chat-lists.functions";

type ChatListResults = Awaited<ReturnType<typeof loadChatLists>>;

/** What one list's read answers with (`readChatLists`). */
export type ChatListValue<List extends ChatListRead> =
  NonNullable<ChatListResults[List]> extends infer Result
    ? Result extends { value: infer Value }
      ? Value
      : never
    : never;

type Waiter = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

/**
 * Reads Chat lists in batches, the way DataLoader batches loads: every list asked for before the
 * scheduled read starts goes into that one call, however many Queries ask (the chat loader's,
 * a restored copy's own read, a burst of realtime re-reads). A list asked for twice is read once.
 * Each list settles with its own answer, so one that failed rejects alone, with the error its own
 * call would have thrown; a call that failed as a whole (signed out, offline) rejects them all.
 */
export function createChatListReader(
  load: (lists: ChatListRead[]) => Promise<ChatListResults>,
  // A macrotask, not a microtask: the Queries of one load start their reads a few promise turns
  // apart (a restored copy's read waits for storage first).
  schedule: (run: () => void) => void = (run) => void setTimeout(run, 0),
) {
  let batch: Map<ChatListRead, Waiter[]> | undefined;
  const send = async (lists: Map<ChatListRead, Waiter[]>) => {
    let results: ChatListResults;
    try {
      results = await load([...lists.keys()]);
    } catch (error) {
      for (const waiters of lists.values()) for (const waiter of waiters) waiter.reject(error);
      return;
    }
    for (const [list, waiters] of lists) {
      const result = results[list];
      for (const waiter of waiters) {
        if (result && "value" in result) waiter.resolve(result.value);
        else {
          const { code, errorId } = result?.error ?? { code: "INTERNAL_ERROR" as const };
          waiter.reject(new AppError(code, errorId ? { errorId } : {}));
        }
      }
    }
  };
  return function read<List extends ChatListRead>(list: List): Promise<ChatListValue<List>> {
    if (!batch) {
      const lists = new Map<ChatListRead, Waiter[]>();
      batch = lists;
      schedule(() => {
        batch = undefined;
        void send(lists);
      });
    }
    const lists = batch;
    return new Promise((resolve, reject) => {
      const waiters = lists.get(list) ?? [];
      waiters.push({ resolve: resolve as Waiter["resolve"], reject });
      lists.set(list, waiters);
    });
  };
}

/** The page's one reader: Chat's lists, the Saved list and every channel's name. */
export const readChatList = createChatListReader((lists) => loadChatLists({ data: { lists } }));
