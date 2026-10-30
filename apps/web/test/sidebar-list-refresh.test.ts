import { describe, expect, test } from "bun:test";

import {
  applyMarked,
  closedConversationLists,
  sidebarListsChangedBy,
  sidebarRefreshQueue,
  channelSignalOf,
  listsMissedBySubscribe,
  rereadMissedBySubscribe,
  unknownAgentOf,
  type ChatList,
} from "#src/features/conversations/conversation-unread";

// Which of the Chat sidebar's lists an event or a subscribe leaves stale, and how they are read
// again.

test("a new top-level message in a chat the sidebar is not showing makes only that kind's list stale", () => {
  // The listed chats: channels and the DMs the sidebar shows, by conversation id.
  const listed = new Set(["channel-1", "dm-listed"]);
  const message = { conversationId: "channel-2", sequence: 5 };

  // A channel missing from the list (the viewer closed it) re-reads the channel list; a closed DM,
  // and a DM that started after the sidebar read its list, re-read the DM list.
  expect(closedConversationLists(message, listed)).toEqual(["channels"]);
  expect(
    closedConversationLists({ ...message, conversationId: "dm-closed", kind: "direct" }, listed),
  ).toEqual(["dms"]);
  expect(
    closedConversationLists({ ...message, conversationId: "dm-new", kind: "direct" }, listed),
  ).toEqual(["dms"]);
  expect(
    closedConversationLists({ ...message, conversationId: "dm-member", kind: "direct" }, listed),
  ).toEqual(["dms"]);

  // Listed chats and thread replies do not: nothing new would appear in the list.
  expect(closedConversationLists({ ...message, conversationId: "channel-1" }, listed)).toEqual([]);
  expect(
    closedConversationLists({ ...message, conversationId: "dm-listed", kind: "direct" }, listed),
  ).toEqual([]);
  expect(closedConversationLists({ ...message, threadRootId: "root-1" }, listed)).toEqual([]);
});

test("a DM signal from an Agent outside the viewer's roster names that Agent; anything else names none", () => {
  const known = new Set(["agent-known"]);
  const message = { conversationId: "dm-1", sequence: 1 };
  // A new Agent (made from an action card, or in another tab) writing first: its row needs it.
  expect(unknownAgentOf({ ...message, kind: "direct", senderAgentId: "agent-new" }, known)).toBe(
    "agent-new",
  );
  expect(
    unknownAgentOf({ ...message, kind: "direct", senderAgentId: "agent-known" }, known),
  ).toBeUndefined();
  expect(unknownAgentOf({ ...message, conversationId: "channel-1" }, known)).toBeUndefined();
});

describe("the viewer's own channel events", () => {
  const marked = (conversationId: string, unreadCount: number) => ({
    type: "channel.marked.v1" as const,
    workspaceId: "workspace-a",
    conversationId,
    unreadCount,
    readThroughSequence: 8,
  });

  test("a read elsewhere sets the channel's badge to the count it left, keeping its boundary", () => {
    const current = { "channel-a": 4, "channel-a:seq": 9, "channel-b": 2 };
    expect(applyMarked(current, marked("channel-a", 1), {})).toEqual({
      "channel-a": 1,
      "channel-a:seq": 9,
      "channel-b": 2,
    });
    expect(applyMarked(current, marked("channel-a", 0), {})).toEqual({
      "channel-a:seq": 9,
      "channel-b": 2,
    });
    // Marked unread in another tab: the badge appears here too.
    expect(applyMarked({}, marked("channel-b", 3), {})).toEqual({ "channel-b": 3 });
  });

  test("the channel on screen keeps no badge, whatever the count", () => {
    const current = { "channel-a:seq": 9 };
    expect(applyMarked(current, marked("channel-a", 2), { openConversationId: "channel-a" })).toBe(
      current,
    );
  });

  test("names the one list each event makes stale, and none for a read", () => {
    const ids = { workspaceId: "workspace-a", conversationId: "channel-a" };
    expect(sidebarListsChangedBy(marked("channel-a", 0))).toEqual([]);
    for (const type of [
      "channel.joined.v1",
      "channel.left.v1",
      "channel.closed.v1",
      "channel.opened.v1",
    ] as const)
      expect(sidebarListsChangedBy({ type, ...ids })).toEqual(["channels"]);
    // A mute is the viewer's, on a channel or on a DM.
    expect(
      sidebarListsChangedBy({ type: "pref.changed.v1", workspaceId: "workspace-a", name: "muted" }),
    ).toEqual(["channels", "dms"]);
    // Pins are one order across channels and DMs.
    expect(
      sidebarListsChangedBy({ type: "pref.changed.v1", workspaceId: "workspace-a", name: "pins" }),
    ).toEqual(["channels", "dms"]);
    // A section made, changed, removed or reordered, or a chat moved into one, on any page or
    // device: the sections and their order, which is how another device's sidebar follows.
    expect(
      sidebarListsChangedBy({
        type: "pref.changed.v1",
        workspaceId: "workspace-a",
        name: "sections",
      }),
    ).toEqual(["sections", "sectionOrder"]);
  });
});

describe("the viewer's own DM events", () => {
  const ids = { workspaceId: "workspace-a", conversationId: "dm-a" };

  test("a DM read elsewhere sets its badge like a channel's", () => {
    expect(
      applyMarked(
        { "dm-a": 5, "dm-a:seq": 7 },
        { type: "dm.marked.v1", ...ids, unreadCount: 0, readThroughSequence: 7 },
        {},
      ),
    ).toEqual({ "dm-a:seq": 7 });
    expect(
      applyMarked(
        {},
        { type: "dm.marked.v1", ...ids, unreadCount: 1, readThroughSequence: 6 },
        { openConversationId: "dm-a" },
      ),
    ).toEqual({});
  });

  test("a DM started, closed or brought back makes only the DM list stale", () => {
    expect(
      sidebarListsChangedBy({
        type: "dm.marked.v1",
        ...ids,
        unreadCount: 0,
        readThroughSequence: 7,
      }),
    ).toEqual([]);
    for (const type of ["dm.created.v1", "dm.opened.v1", "dm.closed.v1"] as const)
      expect(sidebarListsChangedBy({ type, ...ids })).toEqual(["dms"]);
  });
});

test("a save or unsave elsewhere makes only the Saved list stale", () => {
  const ids = { workspaceId: "workspace-a", conversationId: "conversation-a", messageId: "m-1" };
  expect(sidebarListsChangedBy({ type: "saved.added.v1", ...ids })).toEqual(["saved"]);
  expect(sidebarListsChangedBy({ type: "saved.removed.v1", ...ids })).toEqual(["saved"]);
});

describe("sidebarRefreshQueue", () => {
  test("lists named while a re-read is running are read once, together, after it", async () => {
    const reads: string[][] = [];
    const running: (() => void)[] = [];
    const refresh = sidebarRefreshQueue(
      (lists) =>
        new Promise<void>((resolve) => {
          reads.push([...lists].sort());
          running.push(resolve);
        }),
    );
    const first = refresh(["channels"]);
    await Promise.resolve();
    expect(reads).toEqual([["channels"]]);

    const second = refresh(["dms"]);
    const third = refresh(["channels"]);
    expect(second).toBe(third);
    running.shift()!();
    await first;
    await Promise.resolve();
    expect(reads).toEqual([["channels"], ["channels", "dms"]]);
    running.shift()!();
    await second;
  });
});

describe("channelSignalOf", () => {
  const ids = { workspaceId: "workspace-a", conversationId: "channel-z" };

  test("a channel created or changed anywhere in the Workspace is a channel signal", () => {
    const created = { type: "channel.created.v1" as const, ...ids };
    const updated = { type: "channel.updated.v1" as const, ...ids, gone: true as const };
    expect(channelSignalOf(created)).toEqual(created);
    expect(channelSignalOf(updated)).toEqual(updated);
    expect(channelSignalOf(new TextEncoder().encode(JSON.stringify(created)))).toEqual(created);
  });

  test("anything else on the Workspace channel is not a channel signal", () => {
    expect(
      channelSignalOf({
        type: "message.available.v1",
        conversationId: "channel-z",
        messageId: "m",
        sequence: 1,
      }),
    ).toBeUndefined();
    expect(channelSignalOf({ type: "channel.created.v1", workspaceId: "w" })).toBeUndefined();
  });
});

describe("listsMissedBySubscribe", () => {
  test("a subscribe that replayed everything missed nothing", () => {
    expect(listsMissedBySubscribe("workspace", { wasRecovering: true, recovered: true })).toEqual(
      [],
    );
    expect(listsMissedBySubscribe("user", { wasRecovering: true, recovered: true })).toEqual([]);
  });

  test("a first subscribe, or one that lost publications, re-reads what that channel keeps live", () => {
    // The Workspace channel carries channel messages and channel events.
    for (const recovery of [
      { wasRecovering: false, recovered: false },
      { wasRecovering: true, recovered: false },
    ]) {
      expect(listsMissedBySubscribe("workspace", recovery)).toEqual(["channels", "channelNames"]);
      // The viewer's own channel carries message activity, their ViewerEvents and their private
      // channels' events (channels, channel names, DMs, saves, sections and their order).
      expect(listsMissedBySubscribe("user", recovery)).toEqual([
        "channels",
        "channelNames",
        "dms",
        "saved",
        "sections",
        "sectionOrder",
      ]);
    }
  });
});

describe("rereadMissedBySubscribe", () => {
  // A list read at a stream position misses nothing a subscription starting no later delivers
  // (https://centrifugal.dev/docs/server/history_and_recovery).
  const firstSubscribe = (position: () => { offset: number; epoch: string } | undefined) => ({
    wasRecovering: false,
    recovered: false,
    position,
  });
  async function reread(
    channel: "workspace" | "user",
    recovery: Parameters<typeof rereadMissedBySubscribe>[1],
    readPosition: Parameters<typeof rereadMissedBySubscribe>[2],
  ) {
    const batches: (readonly string[])[] = [];
    await rereadMissedBySubscribe(channel, recovery, readPosition, (lists) => batches.push(lists));
    return batches;
  }
  const channelsAt =
    (offset: number, epoch = "e1") =>
    (list: string) =>
      list === "channels" ? Promise.resolve({ offset, epoch }) : undefined;

  test("a first subscribe keeps a list read where the subscription starts, or later", async () => {
    const at7 = () => ({ offset: 7, epoch: "e1" });
    expect(await reread("user", firstSubscribe(at7), channelsAt(7))).toEqual([
      ["channelNames", "dms", "saved"],
    ]);
    // What was published between the two reaches the subscription itself.
    expect(await reread("workspace", firstSubscribe(at7), channelsAt(9))).toEqual([
      ["channelNames"],
    ]);
  });

  test("a list read before the stream moved on, or in another epoch, is re-read", async () => {
    const at7 = () => ({ offset: 7, epoch: "e1" });
    expect(await reread("workspace", firstSubscribe(at7), channelsAt(6))).toEqual([
      ["channelNames"],
      ["channels"],
    ]);
    expect(await reread("workspace", firstSubscribe(at7), channelsAt(7, "e0"))).toEqual([
      ["channelNames"],
      ["channels"],
    ]);
  });

  test("the stream is judged once the read has settled, publications delivered meanwhile included", async () => {
    let stream = { offset: 7, epoch: "e1" };
    let settle: (position: { offset: number; epoch: string }) => void = () => {};
    const read = new Promise<{ offset: number; epoch: string }>((resolve) => (settle = resolve));
    const done = reread(
      "workspace",
      firstSubscribe(() => stream),
      (list) => (list === "channels" ? read : undefined),
    );
    // Delivered while the read was under way; the read, taken earlier, may lack it.
    stream = { offset: 8, epoch: "e1" };
    settle({ offset: 7, epoch: "e1" });
    expect(await done).toEqual([["channelNames"], ["channels"]]);
  });

  test("a list, or a subscription, without a position is re-read", async () => {
    expect(
      await reread(
        "workspace",
        firstSubscribe(() => ({ offset: 7, epoch: "e1" })),
        () => undefined,
      ),
    ).toEqual([["channels", "channelNames"]]);
    expect(
      await reread("workspace", { wasRecovering: false, recovered: false }, channelsAt(7)),
    ).toEqual([["channelNames"], ["channels"]]);
  });

  test("a resubscribe that lost publications re-reads every list whatever its position", async () => {
    const lost = {
      wasRecovering: true,
      recovered: false,
      position: () => ({ offset: 7, epoch: "e1" }),
    };
    expect(await reread("user", lost, channelsAt(7))).toEqual([
      ["channels", "channelNames", "dms", "saved"],
    ]);
  });

  test("a resubscribe that replayed everything re-reads nothing", async () => {
    expect(await reread("user", { wasRecovering: true, recovered: true }, channelsAt(1))).toEqual(
      [],
    );
  });

  describe("with every list read at a position", () => {
    const at7 = () => ({ offset: 7, epoch: "e1" });
    /** Each list's own position, as `useListReadPosition` finds it in that list's query. */
    const read =
      (offsets: Partial<Record<ChatList, number | undefined>>, epoch = "e1") =>
      (list: ChatList) => {
        const offset = offsets[list];
        return offset === undefined ? undefined : Promise.resolve({ offset, epoch });
      };

    test("a quiet first subscribe re-reads nothing", async () => {
      const positions = read({ channels: 7, channelNames: 7, dms: 7, saved: 8 });
      expect(await reread("workspace", firstSubscribe(at7), positions)).toEqual([]);
      expect(await reread("user", firstSubscribe(at7), positions)).toEqual([]);
    });

    test("each list is judged by its own position: only the one the stream moved past is re-read", async () => {
      const positions = read({ channels: 7, channelNames: 6, dms: 5, saved: 7 });
      expect(await reread("workspace", firstSubscribe(at7), positions)).toEqual([["channelNames"]]);
      expect(await reread("user", firstSubscribe(at7), positions)).toEqual([
        ["channelNames"],
        ["dms"],
      ]);
    });

    test("a list read in another epoch is re-read, the others are not", async () => {
      const positions = (list: ChatList) =>
        list === "saved"
          ? Promise.resolve({ offset: 7, epoch: "e0" })
          : read({ channels: 7, dms: 7 })(list);
      expect(await reread("user", firstSubscribe(at7), positions)).toEqual([
        ["channelNames"],
        ["saved"],
      ]);
    });

    test("a list without a position is re-read at once, ahead of the judged ones", async () => {
      const positions = read({ channels: 6, channelNames: 7, dms: 7 });
      expect(await reread("user", firstSubscribe(at7), positions)).toEqual([
        ["saved"],
        ["channels"],
      ]);
    });
  });
});
