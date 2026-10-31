import { describe, expect, test } from "bun:test";

import { applyChannelSignalToLists } from "#src/features/conversations/sidebar-signals";
import { compareChannelNames, type ChannelName } from "#src/features/conversations/channel-signals";
import {
  channelNamesQueryKey,
  channelPageQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import { sidebarWith } from "./helpers/sidebar-fake";

/**
 * The Chat sidebar's channel list under channel events from elsewhere (created, renamed, archived,
 * gone), applied from the event alone where it can be, against fake server calls (moved from
 * `sidebar-collections.test.ts`).
 */

/** The channel rows' ids in the order the sidebar shows them. */
const listed = (sidebar: { channels: { toArray: { id: string; name: string }[] } }) =>
  [...sidebar.channels.toArray]
    .sort((a, b) => compareChannelNames(a.name, b.name))
    .map((row) => row.id);

async function signalSidebar() {
  const setup = await sidebarWith();
  const before = setup.server.channelReads;
  return { ...setup, reads: () => setup.server.channelReads - before };
}

const signalIds = { workspaceId: "w" };

test("a channel created elsewhere is listed in name order, not joined, without a read", async () => {
  const { sidebar, reads } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "lab",
      channel: { name: "lab", description: "", archived: false },
    },
    { known: false },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general", "lab", "random"]);
  expect(sidebar.channels.get("lab")).toMatchObject({
    name: "lab",
    joined: false,
    archived: false,
    muted: false,
    unreadCount: 0,
    hidden: false,
    pinned: false,
    pinSortOrder: null,
  });
  expect(reads()).toBe(0);
});

test("a channel created by the viewer on another page keeps the row the list already has", async () => {
  const { sidebar } = await signalSidebar();
  sidebar.applyChannelSignal(
    {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "random",
      channel: { name: "random", description: "", archived: false },
    },
    { known: false },
  );
  expect(sidebar.channels.get("random")).toMatchObject({ joined: true, unreadCount: 2 });
});

test("a rename or archive elsewhere changes the row and its place, without a read", async () => {
  const { sidebar, reads } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    {
      type: "channel.updated.v1",
      ...signalIds,
      conversationId: "random",
      channel: { name: "a-team", description: "", archived: true },
    },
    { known: true },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general", "random"]);
  expect(sidebar.channels.get("random")).toMatchObject({
    name: "a-team",
    archived: true,
    joined: true,
    unreadCount: 2,
  });
  expect(reads()).toBe(0);
});

test("a deleted or hidden channel leaves the list without a read", async () => {
  const { sidebar, reads } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    { type: "channel.updated.v1", ...signalIds, conversationId: "random", gone: true },
    { known: true },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general"]);
  expect(reads()).toBe(0);
});

test("a change to a channel the list leaves out on purpose changes nothing", async () => {
  // A closed channel is known (every channel's name has it) but not listed.
  const { sidebar } = await signalSidebar();
  const applied = sidebar.applyChannelSignal(
    {
      type: "channel.updated.v1",
      ...signalIds,
      conversationId: "closed",
      channel: { name: "closed", description: "", archived: false },
    },
    { known: true },
  );
  expect(applied).toBe(true);
  expect(listed(sidebar)).toEqual(["general", "random"]);
});

test("a change the list cannot place asks for a read", async () => {
  const { sidebar } = await signalSidebar();
  // #general restored: the viewer's place in it is not in the event.
  expect(
    sidebar.applyChannelSignal(
      {
        type: "channel.updated.v1",
        ...signalIds,
        conversationId: "back",
        channel: { name: "back", description: "", archived: false },
      },
      { known: false },
    ),
  ).toBe(false);
  // An event from an older server names ids only.
  expect(
    sidebar.applyChannelSignal(
      { type: "channel.updated.v1", ...signalIds, conversationId: "random" },
      { known: true },
    ),
  ).toBe(false);
  expect(listed(sidebar)).toEqual(["general", "random"]);
});

test("while a sidebar change is being saved, a channel event asks for a read instead", async () => {
  // A failed save's rollback undoes a direct write made meanwhile, even to another row; a read
  // made meanwhile survives it.
  let failPin!: (error: Error) => void;
  const { sidebar } = await sidebarWith({
    pin: () => new Promise((_, reject) => (failPin = reject)),
  });
  const pinned = sidebar.actions.setPinned({ kind: "channel", channelId: "random" }, true);
  const archiveGeneral = {
    type: "channel.updated.v1" as const,
    ...signalIds,
    conversationId: "general",
    channel: { name: "general", description: "", archived: true },
  };
  expect(sidebar.applyChannelSignal(archiveGeneral, { known: true })).toBe(false);
  failPin(new Error("offline"));
  await pinned.catch(() => undefined);
  expect(sidebar.channels.get("random")?.pinned).toBe(false);
  // Once nothing is pending, events are written again.
  expect(sidebar.applyChannelSignal(archiveGeneral, { known: true })).toBe(true);
  expect(sidebar.channels.get("general")?.archived).toBe(true);
});

test("a channel event before the list has synced asks for a read instead of failing", async () => {
  const { sidebar } = await sidebarWith({}, { synced: false });
  expect(
    sidebar.applyChannelSignal(
      {
        type: "channel.created.v1",
        ...signalIds,
        conversationId: "lab",
        channel: { name: "lab", description: "", archived: false },
      },
      { known: false },
    ),
  ).toBe(false);
});

describe("applyChannelSignalToLists", () => {
  const lab = { name: "lab", description: "", archived: false };
  const streamPositions = { "chat:workspace:w": { offset: 5, epoch: "e1" } };
  type NamesRead = { names: ChannelName[]; streamPositions: typeof streamPositions };
  async function withNames() {
    const setup = await sidebarWith();
    setup.queryClient.setQueryData<NamesRead>(channelNamesQueryKey("w"), {
      streamPositions,
      names: [{ id: "general", name: "general", description: "", archived: false }],
    });
    return setup;
  }

  test("a created channel is written into every channel's name and the list, with no read", async () => {
    const { sidebar, queryClient } = await withNames();
    const stale = applyChannelSignalToLists(queryClient, "w", sidebar, {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "lab",
      channel: lab,
    });
    expect(stale).toEqual([]);
    expect(queryClient.getQueryData<NamesRead>(channelNamesQueryKey("w"))).toEqual({
      // A write from an event is not a server read: the positions the names were read at stay.
      streamPositions,
      names: [
        { id: "general", name: "general", description: "", archived: false },
        { id: "lab", ...lab },
      ],
    });
    expect(listed(sidebar)).toEqual(["general", "lab", "random"]);
  });

  test("a channel made private keeps its row for its members, now marked private (task #302)", async () => {
    const { sidebar, queryClient } = await withNames();
    applyChannelSignalToLists(queryClient, "w", sidebar, {
      type: "channel.updated.v1",
      ...signalIds,
      conversationId: "random",
      channel: { name: "random", description: "", archived: false, visibility: "private" },
    });
    expect(sidebar.channels.get("random")?.visibility).toBe("private");
  });

  test("a channel gone for the viewer leaves the list, and its open page reads again (task #302)", async () => {
    const { sidebar, queryClient } = await withNames();
    // Made private, an outsider's subscription to the channel ends before its own event is sent:
    // only this signal says the page they have open is no longer theirs.
    queryClient.setQueryData(channelPageQueryKey("random"), { pages: [], pageParams: [] });
    applyChannelSignalToLists(queryClient, "w", sidebar, {
      type: "channel.updated.v1",
      ...signalIds,
      conversationId: "random",
      gone: true,
    });
    expect(listed(sidebar)).toEqual(["general"]);
    expect(queryClient.getQueryState(channelPageQueryKey("random"))?.isInvalidated).toBe(true);
  });

  test("an ids-only event, a channel coming back, or no hydrated sidebar is re-read", async () => {
    const { sidebar, queryClient } = await withNames();
    const idsOnly = { type: "channel.updated.v1" as const, ...signalIds, conversationId: "random" };
    expect(applyChannelSignalToLists(queryClient, "w", sidebar, idsOnly)).toEqual([
      "channelNames",
      "channels",
    ]);
    // #general restored: every channel's name had dropped it, so the list cannot place it.
    expect(
      applyChannelSignalToLists(queryClient, "w", sidebar, {
        type: "channel.updated.v1",
        ...signalIds,
        conversationId: "back",
        channel: lab,
      }),
    ).toEqual(["channels"]);
    expect(
      applyChannelSignalToLists(queryClient, "w", undefined, {
        type: "channel.created.v1",
        ...signalIds,
        conversationId: "new",
        channel: lab,
      }),
    ).toEqual(["channels"]);
  });

  test("a list being read when the event lands is read again, so an older answer cannot win", async () => {
    const { sidebar, queryClient } = await withNames();
    const reading = sidebar.channels.utils.refetch();
    const stale = applyChannelSignalToLists(queryClient, "w", sidebar, {
      type: "channel.created.v1",
      ...signalIds,
      conversationId: "lab",
      channel: lab,
    });
    expect(stale).toEqual(["channels"]);
    await reading;
  });
});
