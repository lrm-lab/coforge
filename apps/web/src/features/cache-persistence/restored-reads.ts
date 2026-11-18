import type { Query, QueryClient } from "@tanstack/react-query";

import { isAppErrorCode } from "#src/lib/app-error";

export const RESTORED_READ_RETRY = { firstMs: 1_000, maxMs: 30_000 };

export function followRestoredReads(
  queryClient: QueryClient,
  {
    retry = RESTORED_READ_RETRY,
    visible = () => typeof document === "undefined" || document.visibilityState === "visible",
  }: { retry?: typeof RESTORED_READ_RETRY; visible?: () => boolean } = {},
) {
  const awaiting = new Set<string>();
  const restoring = new Set<string>();
  const retries = new Map<string, { failures: number; timer?: ReturnType<typeof setTimeout> }>();
  const stopRetrying = (queryHash: string) => {
    clearTimeout(retries.get(queryHash)?.timer);
    retries.delete(queryHash);
  };
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const read = (query: Query) => void query.fetch().catch(() => {});
  queryClient.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (event.type === "removed") {
      restoring.delete(query.queryHash);
      stopRetrying(query.queryHash);
      if (awaiting.delete(query.queryHash)) notify();
      return;
    }
    if (event.type !== "updated" || !awaiting.has(query.queryHash)) return;
    const { action } = event;
    if (action.type === "success" && !action.manual && restoring.delete(query.queryHash)) {
      query.invalidate();
      return;
    }
    if (action.type === "success" && !action.manual) {
      if (query.state.fetchMeta?.fetchMore) {
        query.invalidate();
        read(query);
        return;
      }
      awaiting.delete(query.queryHash);
      stopRetrying(query.queryHash);
      notify();
      return;
    }
    if (action.type === "error") {
      if (isAppErrorCode(action.error, "NOT_FOUND")) return;
      const entry = retries.get(query.queryHash) ?? { failures: 0 };
      entry.failures += 1;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () => {
          entry.timer = undefined;
          if (awaiting.has(query.queryHash) && visible()) read(query);
        },
        Math.min(retry.maxMs, retry.firstMs * 2 ** (entry.failures - 1)),
      );
      retries.set(query.queryHash, entry);
    }
    if (!query.state.isInvalidated) query.invalidate();
  });
  return {
    restored(query: Query) {
      awaiting.add(query.queryHash);
      restoring.add(query.queryHash);
      notify();
      setTimeout(() => read(query), 0);
    },
    replaced(query: Query) {
      stopRetrying(query.queryHash);
      if (awaiting.delete(query.queryHash)) notify();
    },
    awaiting: (queryHash: string) => awaiting.has(queryHash),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
