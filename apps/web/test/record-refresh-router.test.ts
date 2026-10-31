import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { catalogShouldReload, isRecordsMatch } from "#src/features/records/use-record-refresh";

/**
 * Task #366: a record's page reloading itself must not read the Records catalog or the Workspace
 * again. The router reads every stale route again on a reload of the same address, however
 * narrowly it was invalidated; this holds the catalog route's `shouldReload` to account for that,
 * through the router itself, so an upgrade that changes it shows here.
 */
function recordsRouter() {
  const reads = { workspace: 0, catalog: 0, record: 0 };
  const root = createRootRoute();
  const workspace = createRoute({
    getParentRoute: () => root,
    path: "/w/$workspaceSlug",
    staleTime: Infinity,
    loader: () => void reads.workspace++,
  });
  const catalog = createRoute({
    getParentRoute: () => workspace,
    path: "records",
    shouldReload: catalogShouldReload,
    loader: () => void reads.catalog++,
  });
  const record = createRoute({
    getParentRoute: () => catalog,
    path: "$recordId",
    staleTime: 0,
    loader: () => void reads.record++,
  });
  const router = createRouter({
    routeTree: root.addChildren([workspace.addChildren([catalog.addChildren([record])])]),
    history: createMemoryHistory({ initialEntries: ["/w/acme/records/one"] }),
    isServer: false,
    origin: "http://localhost",
  });
  return { router, reads };
}

test("a record reloading itself reads it alone", async () => {
  const { router, reads } = recordsRouter();
  await router.load();
  expect(reads).toEqual({ workspace: 1, catalog: 1, record: 1 });
  const own = router.state.matches.at(-1)!.id;
  await router.invalidate({ filter: (match) => match.id === own, sync: true });
  expect(reads).toEqual({ workspace: 1, catalog: 1, record: 2 });
});

test("a Records refresh reads the catalog and the record, not the Workspace", async () => {
  const { router, reads } = recordsRouter();
  await router.load();
  await router.invalidate({ filter: isRecordsMatch, sync: true });
  expect(reads).toEqual({ workspace: 1, catalog: 2, record: 2 });
});

test("entering Records again reads the catalog, as before", async () => {
  const { router, reads } = recordsRouter();
  await router.load();
  for (const path of ["/w/acme", "/w/acme/records/two"]) {
    router.history.push(path);
    await router.load();
  }
  expect(reads.catalog).toBe(2);
});
