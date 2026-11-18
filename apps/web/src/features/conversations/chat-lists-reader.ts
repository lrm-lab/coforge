import { AppError } from "#src/lib/app-error";
import { nextTask } from "#src/lib/next-task";
import { workspaceSlugFromPath } from "#src/features/workspaces/workspace-url";
import type { ChatListRead } from "./chat-list-reads";
import { loadChatLists } from "./chat-lists.functions";

type ChatListResults = Awaited<ReturnType<typeof loadChatLists>>;

export type ChatListValue<List extends ChatListRead> = Extract<
  NonNullable<ChatListResults[List]>,
  { value: unknown }
>["value"];

type Deferred = ReturnType<typeof Promise.withResolvers<unknown>>;
type Batch = { workspace: string | undefined; lists: Map<ChatListRead, Deferred>; grew: boolean };

const MAX_WAITS = 8;

const pageWorkspace = () =>
  typeof window === "undefined" ? undefined : workspaceSlugFromPath(window.location.pathname);

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

export const readChatList = createChatListReader((lists) => loadChatLists({ data: { lists } }));
