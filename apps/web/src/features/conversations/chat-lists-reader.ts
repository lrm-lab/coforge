import { AppError } from "#src/lib/app-error";
import { workspaceSlugFromPath } from "#src/features/workspaces/workspace-url";
import type { ChatListRead } from "./chat-list-reads";
import { loadChatLists } from "./chat-lists.functions";

type ChatListResults = Awaited<ReturnType<typeof loadChatLists>>;

/** What one list's read answers with (`readChatLists`). */
export type ChatListValue<List extends ChatListRead> = Extract<
  NonNullable<ChatListResults[List]>,
  { value: unknown }
>["value"];

type Deferred = ReturnType<typeof Promise.withResolvers<unknown>>;
/** `grew`: a list joined since the batch last looked. */
type Batch = { workspace: string | undefined; lists: Map<ChatListRead, Deferred>; grew: boolean };

/** How many tasks more a growing batch waits before it goes out regardless. */
const MAX_WAITS = 8;

/** Runs `run` once the current task is done, as a message event: the Queries of one load start
 * their reads a few promise turns apart, and a hidden tab holds a timer back for a second, never a
 * message. */
function nextTask(run: () => void) {
  if (typeof MessageChannel === "undefined") return void setTimeout(run, 0);
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    run();
  };
  channel.port2.postMessage(undefined);
}

/** The Workspace a call names: the server function takes it from the page's address when the
 * call is sent (`workspaceUserMiddleware`). */
const pageWorkspace = () =>
  typeof window === "undefined" ? undefined : workspaceSlugFromPath(window.location.pathname);

/**
 * Reads Chat lists in batches, the way DataLoader batches loads: every list asked for before the
 * scheduled read starts (a task after the last list joined, up to `MAX_WAITS` tasks) goes into
 * that one call, however many Queries ask (the chat loader's,
 * a restored copy's own read, a burst of realtime re-reads). A list asked for twice is read once.
 * Each list settles with its own answer, so one that failed rejects alone, with the error its own
 * call would have thrown; a call that failed as a whole (signed out, offline) rejects them all, as
 * does a batch whose page has moved to another Workspace before it was sent, which would read
 * that Workspace's lists into these Queries.
 */
export function createChatListReader(
  load: (lists: ChatListRead[]) => Promise<ChatListResults>,
  { schedule = nextTask, workspace = pageWorkspace } = {},
) {
  let batch: Batch | undefined;
  const send = async ({ workspace: asked, lists }: Batch) => {
    try {
      if (workspace() !== asked) throw new AppError("TEMPORARILY_UNAVAILABLE");
      const results = await load([...lists.keys()]);
      for (const [list, deferred] of lists) {
        const result = results[list];
        if (result && "value" in result) deferred.resolve(result.value);
        else {
          const { code, errorId } = result?.error ?? { code: "INTERNAL_ERROR" as const };
          deferred.reject(new AppError(code, errorId ? { errorId } : {}));
        }
      }
    } catch (error) {
      for (const deferred of lists.values()) deferred.reject(error);
    }
  };
  return function read<List extends ChatListRead>(list: List): Promise<ChatListValue<List>> {
    const here = workspace();
    if (!batch || batch.workspace !== here) {
      const next: Batch = { workspace: here, lists: new Map(), grew: false };
      batch = next;
      let waited = 0;
      const sendOnceQuiet = () => {
        // Each Query's read starts after its own look into the stored cache (IndexedDB), which
        // answers in a task of its own: while the batch still grew in the task just past, another
        // list is likely a lookup away, so it waits one task more, a few at most (task #438: a
        // load split its seven lists into two calls about half the time).
        if (next.grew && waited < MAX_WAITS) {
          next.grew = false;
          waited += 1;
          schedule(sendOnceQuiet);
          return;
        }
        if (batch === next) batch = undefined;
        void send(next);
      };
      schedule(sendOnceQuiet);
    }
    let deferred = batch.lists.get(list);
    if (!deferred) {
      batch.lists.set(list, (deferred = Promise.withResolvers()));
      batch.grew = true;
    }
    return deferred.promise as Promise<ChatListValue<List>>;
  };
}

/** The page's one reader: Chat's lists, the Saved list and every channel's name. */
export const readChatList = createChatListReader((lists) => loadChatLists({ data: { lists } }));
