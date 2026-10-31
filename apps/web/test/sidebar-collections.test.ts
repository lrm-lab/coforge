import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import {
  sidebarChannelsQuery,
  sidebarDirectsQuery,
  type Arrangement,
  type SidebarApi,
  channelNamesBehind,
} from "#src/features/conversations/sidebar-collections";
import type { StreamPositions } from "#src/features/realtime/subscription-gap";
import { serverlessApi, sidebarWith } from "./helpers/sidebar-fake";

/**
 * The Chat sidebar's lists and the changes made from the sidebar, against fake server calls: each
 * change shows at once, is saved, and stays as shown or goes back; failed re-reads keep the rows.
 */

test("marking unread saves even when the row already shows a count", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.markUnread({ kind: "channel", channelId: "random" });
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"random"}`]);
});

test("marking unread a row with no count shows one at once and saves it", async () => {
  const { sidebar, saves } = await sidebarWith();
  const saved = sidebar.actions.markUnread({ kind: "channel", channelId: "general" });
  expect(sidebar.channels.get("general")?.unreadCount).toBe(1);
  await saved;
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"general"}`]);
});

test("marking unread a row already showing a count changes nothing on screen but is saved", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.markUnread({ kind: "channel", channelId: "random" });
  expect(sidebar.channels.get("random")?.unreadCount).toBe(2);
  expect(saves).toEqual([`unread {"kind":"channel","channelId":"random"}`]);
});

test("a change made before the lists have synced (another page) is saved and marks them stale", async () => {
  const { sidebar, saves, queryClient } = await sidebarWith({}, { synced: false });
  const stale = () =>
    [sidebarChannelsQuery("w"), sidebarDirectsQuery("w")].map(
      (query) => queryClient.getQueryState(query.queryKey)?.isInvalidated,
    );
  expect(stale()).toEqual([false, false]);
  await sidebar.actions.markUnread({ kind: "direct", conversationId: "dm-helper" });
  await sidebar.actions.setPinned({ kind: "channel", channelId: "random" }, true);
  await sidebar.actions.close({ kind: "channel", channelId: "random" });
  expect(saves).toEqual([
    `unread {"kind":"direct","conversationId":"dm-helper"}`,
    `pin {"kind":"channel","channelId":"random"} true`,
    `close {"kind":"channel","channelId":"random"}`,
  ]);
  // The next page to show the lists reads them again instead of the copy from before.
  expect(stale()).toEqual([true, true]);
});

test("a pin shows at once, is saved, and stays when a later re-read fails", async () => {
  const { sidebar, saves, server } = await sidebarWith();
  const saved = sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  expect(sidebar.channels.get("general")?.pinned).toBe(true);
  await saved;
  expect(saves).toEqual([`pin {"kind":"channel","channelId":"general"} true`]);

  server.failReads = true;
  await sidebar.channels.utils.refetch();
  expect(sidebar.channels.get("general")).toMatchObject({ pinned: true, pinSortOrder: 1 });
});

test("a saved change is not a server read: the lists' read time stays", async () => {
  const { sidebar, queryClient } = await sidebarWith();
  const key = sidebarChannelsQuery("w").queryKey;
  const before = queryClient.getQueryState(key)!;
  await sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  const after = queryClient.getQueryState(key)!;
  // The save wrote the cache (its data is new) but the read time it carries is the old one.
  expect(after.data).not.toBe(before.data);
  expect(after.data?.fetchedAt).toBe(before.data?.fetchedAt);
});

test("a failed save puts the row back and rejects", async () => {
  const { sidebar } = await sidebarWith({
    pin: async () => {
      throw new Error("refused");
    },
  });
  const saved = sidebar.actions.setPinned({ kind: "channel", channelId: "general" }, true);
  await expect(saved).rejects.toThrow("refused");
  expect(sidebar.channels.get("general")?.pinned).toBe(false);
});

test("a failed DM re-read keeps the rows it has", async () => {
  const { sidebar, server } = await sidebarWith();
  server.failReads = true;
  await sidebar.directs.utils.refetch();
  expect(sidebar.directs.get("dm-helper")).toMatchObject({
    pinned: true,
    peer: { kind: "agent", agentId: "helper" },
  });
});

test("a DM row changes by its conversation id, a DM between members as one with an Agent", async () => {
  const { sidebar, saves } = await sidebarWith();
  const pinned = sidebar.actions.setPinned({ kind: "direct", conversationId: "dm-grace" }, true);
  // After the viewer's other pin.
  expect(sidebar.directs.get("dm-grace")).toMatchObject({ pinned: true, pinSortOrder: 1 });
  await pinned;
  const closed = sidebar.actions.close({ kind: "direct", conversationId: "dm-grace" });
  expect(sidebar.directs.get("dm-grace")?.hidden).toBe(true);
  await closed;
  expect(saves).toEqual([
    `pin {"kind":"direct","conversationId":"dm-grace"} true`,
    `close {"kind":"direct","conversationId":"dm-grace"}`,
  ]);
});

test("a mute shows at once on a channel row and on a DM row, and is saved", async () => {
  const { sidebar, saves } = await sidebarWith();
  const channelMuted = sidebar.actions.setMuted({ kind: "channel", channelId: "general" }, true);
  expect(sidebar.channels.get("general")?.muted).toBe(true);
  await channelMuted;
  const dmMuted = sidebar.actions.setMuted({ kind: "direct", conversationId: "dm-grace" }, true);
  expect(sidebar.directs.get("dm-grace")?.muted).toBe(true);
  await dmMuted;
  expect(sidebar.directs.get("dm-helper")?.muted).toBe(false);
  await sidebar.actions.setMuted({ kind: "direct", conversationId: "dm-grace" }, false);
  expect(sidebar.directs.get("dm-grace")?.muted).toBe(false);
  expect(saves).toEqual([
    `mute {"kind":"channel","channelId":"general"} true`,
    `mute {"kind":"direct","conversationId":"dm-grace"} true`,
    `mute {"kind":"direct","conversationId":"dm-grace"} false`,
  ]);
});

test("a failed mute puts the row back and rejects", async () => {
  const { sidebar } = await sidebarWith({
    setMuted: async () => {
      throw new Error("refused");
    },
  });
  const saved = sidebar.actions.setMuted({ kind: "direct", conversationId: "dm-grace" }, true);
  await expect(saved).rejects.toThrow("refused");
  expect(sidebar.directs.get("dm-grace")?.muted).toBe(false);
});

test("a change to a row that has left the list is still saved", async () => {
  const { sidebar, saves } = await sidebarWith();
  await sidebar.actions.close({ kind: "channel", channelId: "gone" });
  expect(saves).toEqual([`close {"kind":"channel","channelId":"gone"}`]);
});

test("drags are saved one after another, in the order they were made", async () => {
  const started: string[] = [];
  let releaseFirst = () => {};
  let firstStarted = () => {};
  const firstCalled = new Promise<void>((resolve) => (firstStarted = resolve));
  const { sidebar } = await sidebarWith({
    arrange: (arrangement: Arrangement) => {
      const first = arrangement.pins[0];
      const name = first?.kind === "channel" ? first.channelId : "helper";
      started.push(name);
      if (name !== "general") return Promise.resolve();
      firstStarted();
      return new Promise<void>((resolve) => (releaseFirst = resolve));
    },
  });
  const first = sidebar.actions.arrange({
    pins: [{ kind: "channel", channelId: "general" }],
    unpinned: [],
  });
  const second = sidebar.actions.arrange({
    pins: [{ kind: "channel", channelId: "random" }],
    unpinned: [],
  });
  try {
    await firstCalled;
    // The second drag waits for the first save: nothing else has reached the server.
    expect(started).toEqual(["general"]);
  } finally {
    releaseFirst();
  }
  await Promise.all([first, second]);
  expect(started).toEqual(["general", "random"]);
});

test("the channel names are behind the sidebar when a listed channel is missing or renamed there", () => {
  const names = [
    { id: "c1", name: "general" },
    { id: "c2", name: "design" },
  ];
  expect(channelNamesBehind(names, [{ id: "c1", name: "general" }])).toBe(false);
  // Created elsewhere while this page was away from Chat.
  expect(channelNamesBehind(names, [{ id: "c3", name: "launch" }])).toBe(true);
  // Renamed elsewhere.
  expect(channelNamesBehind(names, [{ id: "c2", name: "design-team" }])).toBe(true);
  // The names list closed and archived channels too: fewer rows is not behind.
  expect(channelNamesBehind(names, [])).toBe(false);
});

describe("the DM list's stream positions", () => {
  // The list is two server reads, each taken at the viewer's own signal channel's position.
  const viewerChannel = "chat:user:viewer";
  const at = (offset: number, epoch = "e1") => ({ [viewerChannel]: { offset, epoch } });
  async function directsRead(
    read: {
      preferences: StreamPositions;
      badges: StreamPositions;
      failing?: "preferences" | "badges";
    },
    tolerant = false,
  ) {
    const server = {
      channels: [],
      preferences: { conversations: [], pinned: [], hidden: [], streamPositions: read.preferences },
    };
    const api: SidebarApi = {
      ...serverlessApi(server),
      loadDirectPreferences: async () => {
        if (read.failing === "preferences") throw new Error("offline");
        return server.preferences;
      },
      loadDirectBadges: async () => {
        if (read.failing === "badges") throw new Error("offline");
        return { viewerId: "viewer", unread: {}, streamPositions: read.badges };
      },
    };
    return new QueryClient().query(sidebarDirectsQuery("w", { tolerant, api }));
  }

  test("the list stands at the older of its two reads, per channel", async () => {
    expect((await directsRead({ preferences: at(9), badges: at(7) })).streamPositions).toEqual(
      at(7),
    );
    expect((await directsRead({ preferences: at(3), badges: at(7) })).streamPositions).toEqual(
      at(3),
    );
  });

  test("reads in different epochs, or a channel only one read has, leave no position", async () => {
    expect(
      (await directsRead({ preferences: at(9, "e2"), badges: at(7, "e1") })).streamPositions,
    ).toEqual({});
    expect((await directsRead({ preferences: {}, badges: at(7) })).streamPositions).toEqual({});
    expect((await directsRead({ preferences: at(7), badges: {} })).streamPositions).toEqual({});
  });

  test("a first load that fell back on a failed read has no position, though the other read has", async () => {
    for (const failing of ["preferences", "badges"] as const) {
      const directs = await directsRead({ preferences: at(7), badges: at(7), failing }, true);
      expect(directs).toMatchObject({ partial: true, streamPositions: {} });
    }
  });
});
