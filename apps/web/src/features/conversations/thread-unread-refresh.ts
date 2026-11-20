export const THREAD_UNREAD_BATCH = 100;
const THREAD_UNREAD_RETRY_DELAYS_MS = [250, 1_000, 4_000];

export type ThreadUnreadRow = {
  conversationId: string;
  unreadThreadCount: number;
  threadMentioned: boolean;
};

type ReadRows = (
  workspaceId: string,
  conversationIds: readonly string[],
) => Promise<readonly ThreadUnreadRow[]>;

export function createThreadUnreadRefresh(options: {
  read: ReadRows;
  apply: (workspaceId: string, rows: readonly ThreadUnreadRow[]) => void;
  onError?: (cause: unknown) => void;
  schedule?: (task: () => void) => void;
  batch?: number;
  retryDelays?: readonly number[];
}) {
  const {
    read,
    apply,
    onError,
    schedule = (task: () => void) => queueMicrotask(task),
    batch = THREAD_UNREAD_BATCH,
    retryDelays = THREAD_UNREAD_RETRY_DELAYS_MS,
  } = options;
  let workspaceId: string | undefined;
  let generation = 0;
  let scheduled = false;
  let inflight: Promise<void> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const pending = new Set<string>();

  const enqueue = () => {
    if (scheduled || retryTimer !== undefined) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void start();
    });
  };

  async function run(): Promise<boolean> {
    if (!workspaceId || pending.size === 0) return false;
    const workspace = workspaceId;
    const at = generation;
    const asked = [...pending].slice(0, batch);
    for (const id of asked) pending.delete(id);
    try {
      const rows = await read(workspace, asked);
      if (at !== generation) return false;
      const returned = new Map(rows.map((row) => [row.conversationId, row]));
      const settled = asked
        .filter((id) => !pending.has(id))
        .map(
          (id) =>
            returned.get(id) ?? {
              conversationId: id,
              unreadThreadCount: 0,
              threadMentioned: false,
            },
        );
      if (settled.length > 0) apply(workspace, settled);
      return true;
    } catch (cause) {
      if (at === generation) for (const id of asked) pending.add(id);
      onError?.(cause);
      return false;
    }
  }

  function start(): Promise<void> {
    if (inflight) return inflight;
    const started = run().then((continueReading) => {
      if (inflight !== started) return;
      inflight = undefined;
      if (continueReading) {
        failures = 0;
        if (pending.size > 0) enqueue();
      } else if (pending.size > 0) {
        const delay = retryDelays[failures++];
        if (delay !== undefined) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            enqueue();
          }, delay);
        }
      }
    });
    inflight = started;
    return started;
  }

  function cancelRetry() {
    if (retryTimer === undefined) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  return {
    setWorkspace(next: string | undefined) {
      if (next === workspaceId) return;
      workspaceId = next;
      generation += 1;
      pending.clear();
      inflight = undefined;
      failures = 0;
      cancelRetry();
    },
    invalidate(workspaceOfChannel: string, conversationId: string) {
      if (workspaceOfChannel !== workspaceId) return;
      pending.add(conversationId);
      if (failures > retryDelays.length && !inflight) failures = 0;
      enqueue();
    },
    flush(): Promise<void> {
      cancelRetry();
      return start();
    },
    pendingCount() {
      return pending.size;
    },
  };
}
