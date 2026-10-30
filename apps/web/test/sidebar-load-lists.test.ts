import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  loadSidebarLists,
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type SidebarApi,
} from "#src/features/conversations/sidebar-collections";
import { serverlessApi, sidebarWith } from "./helpers/sidebar-fake";

describe("loadSidebarLists", () => {
  // The chat layout's loader runs on every navigation inside Chat. The lists stay live through
  // realtime (and a subscribe's gap re-read), so a navigation reads only what is not cached.
  async function counted() {
    const reads = { channels: 0, directs: 0 };
    const { server, queryClient } = await sidebarWith();
    const api: SidebarApi = {
      ...serverlessApi(server),
      listChannels: async () => {
        reads.channels += 1;
        return { streamPositions: {}, channels: server.channels };
      },
      loadDirectPreferences: async () => {
        reads.directs += 1;
        return server.preferences;
      },
    };
    return { reads, api, fresh: new QueryClient(), queryClient };
  }

  test("a first load reads both lists; moving between chats reads neither", async () => {
    const { reads, api, fresh } = await counted();
    await loadSidebarLists(fresh, "w", "enter", api);
    expect(reads).toEqual({ channels: 1, directs: 1 });
    await loadSidebarLists(fresh, "w", "stay", api);
    await loadSidebarLists(fresh, "w", "enter", api);
    expect(reads).toEqual({ channels: 1, directs: 1 });
  });

  test("a first load that fell back on a failed read is read again on the next navigation", async () => {
    const { reads, api, fresh } = await counted();
    let badgesDown = true;
    const flaky: SidebarApi = {
      ...api,
      loadDirectBadges: async () => {
        if (badgesDown) throw new Error("offline");
        return { viewerId: "viewer", unread: {}, streamPositions: {} };
      },
    };
    await loadSidebarLists(fresh, "w", "enter", flaky);
    expect(fresh.getQueryData(sidebarDirectsQuery("w").queryKey)?.viewerId).toBeUndefined();
    badgesDown = false;
    await loadSidebarLists(fresh, "w", "stay", flaky);
    expect(reads.directs).toBe(2);
    expect(fresh.getQueryData(sidebarDirectsQuery("w").queryKey)?.viewerId).toBe("viewer");
  });

  test("a list marked stale is read on the next navigation, a hover preload never reads", async () => {
    const { reads, api, fresh } = await counted();
    await loadSidebarLists(fresh, "w", "enter", api);
    await fresh.invalidateQueries({ queryKey: sidebarChannelsQuery("w").queryKey });
    await loadSidebarLists(fresh, "w", "preload", api);
    expect(reads).toEqual({ channels: 1, directs: 1 });
    await loadSidebarLists(fresh, "w", "stay", api);
    expect(reads).toEqual({ channels: 2, directs: 1 });
  });
});
