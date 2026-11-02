import type { QueryClient } from "@tanstack/react-query";

import { createIdbStore } from "./idb-store";
import { installQueryCachePersistence } from "./query-cache-persistence";

// The browser's copy of the Query cache (see `features/cache-persistence/AGENTS.md`): the wiring
// of the persistence to IndexedDB, and one QueryClient per page. What a stored row must look like
// to be opened is `STORED_SHAPE_VERSION` (`persisted-queries.ts`), not the build: a deploy keeps
// what is stored.

type Persistence = ReturnType<typeof installQueryCachePersistence>;
const installed = new WeakMap<QueryClient, Persistence>();
let current: Persistence | undefined;

/**
 * Keeps the client's kept queries in IndexedDB and opens later pages from them. A no-op where
 * there is no IndexedDB, which includes the server render (one QueryClient per request, nothing
 * to keep). `viewerId` is who is signed in as of now; nothing is read or written before it says.
 */
export function installBrowserQueryCachePersistence(
  queryClient: QueryClient,
  viewerId: () => string | undefined,
) {
  if (typeof indexedDB === "undefined") return;
  const persistence = installQueryCachePersistence(queryClient, {
    store: createIdbStore(),
    viewerId,
  });
  installed.set(queryClient, persistence);
  current = persistence;
}

/** Whether the query `queryKey` still shows the copy restored from storage, and the way to hear it
 * change (`followRestoredReads`); always false where nothing is kept. */
export function restoredCopyShown(queryClient: QueryClient, queryKey: readonly unknown[]) {
  return installed.get(queryClient)?.restoredCopyShown(queryKey) ?? false;
}

/** The query `queryKey` was given data read from the server by hand: it no longer shows its
 * restored copy (`followRestoredReads`). A no-op where nothing is kept. */
export function noteRestoredCopyReplaced(queryClient: QueryClient, queryKey: readonly unknown[]) {
  installed.get(queryClient)?.restoredCopyReplaced(queryKey);
}

export function subscribeRestoredReads(queryClient: QueryClient, listener: () => void) {
  return installed.get(queryClient)?.subscribeRestoredReads(listener) ?? (() => {});
}

/** Stores the kept query `queryKey` as the page holds it now (`store`). Resolves at once where
 * nothing is kept. */
export async function storeQueryNow(queryClient: QueryClient, queryKey: readonly unknown[]) {
  await installed.get(queryClient)?.store(queryKey);
}

/** The page is up: stores the kept queries it already holds, and sweeps what has aged out. */
export async function rememberQueryCache(queryClient: QueryClient) {
  const persistence = installed.get(queryClient);
  if (!persistence) return;
  await persistence.seed();
  await persistence.collectGarbage();
}

/** Removes every kept query from this browser, and keeps this page from keeping more. Sign-out. */
export async function forgetQueryCache() {
  if (current) await current.purge();
  else if (typeof indexedDB !== "undefined") await createIdbStore().clear();
}
