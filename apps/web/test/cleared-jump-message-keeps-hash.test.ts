import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { clearedJumpMessageNavigation } from "#src/features/conversations/open-conversation-thread";

function channelRouter(entry: string) {
  const root = createRootRoute();
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/$channelId",
    validateSearch: (search: Record<string, unknown>) =>
      search as { message?: string; threadRootId?: string; file?: string },
  });
  return createRouter({
    routeTree: root.addChildren([channel]),
    history: createMemoryHistory({ initialEntries: [entry] }),
    isServer: false,
    origin: "http://localhost",
  });
}

test("clearing a reply link's message jump keeps the reply it lands on", async () => {
  const router = channelRouter("/channel/c?threadRootId=r&message=r#message-reply");
  await router.load();
  await router.navigate(clearedJumpMessageNavigation);
  expect(router.state.location.hash).toBe("message-reply");
  expect(router.state.location.search).toEqual({ threadRootId: "r" });
});

test("clearing a plain message jump leaves the address without a hash", async () => {
  const router = channelRouter("/channel/c?message=m");
  await router.load();
  await router.navigate(clearedJumpMessageNavigation);
  expect(router.state.location.hash).toBe("");
  expect(router.state.location.search).toEqual({});
});
