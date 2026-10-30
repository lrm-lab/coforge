import { describe, expect, test } from "bun:test";

import {
  applyUnreadEvent,
  storedCursorMove,
  clearUnread,
  closedConversationLists,
  seedUnreadCounts,
  replaceUnreadCounts,
  unreadIdsToKeep,
  latestTopLevelSequence,
  persistReadCursor,
} from "#src/features/conversations/conversation-unread";
import {
  decodeMessageAvailableEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";

const channels = new Set(["channel-a", "channel-b"]);

describe("seedUnreadCounts", () => {
  test("seeds from the server payload and skips zero counts", () => {
    const seeded = seedUnreadCounts([
      { id: "channel-a", unreadCount: 3 },
      { id: "channel-b" },
      { id: "channel-c", unreadCount: 0 },
      { id: "channel-d", unreadCount: 2 },
    ]);
    expect(seeded).toEqual({ "channel-a": 3, "channel-d": 2 });
  });
});

describe("applyUnreadEvent", () => {
  test("bumps only listed, not-open channels on a top-level message", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels },
    );
    expect(next).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
  });

  test("ignores channel events for conversations outside the known set", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-z", sequence: 5 },
      { conversations: channels },
    );
    expect(next).toEqual({});
  });

  test("ignores events for the currently open conversation", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      {
        conversations: channels,
        openConversationId: "channel-a",
      },
    );
    expect(next).toEqual({});
  });

  test("never counts thread replies into conversation unread", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5, threadRootId: "root-1" },
      { conversations: channels },
    );
    expect(next).toEqual({});
  });

  test("does not double-count a late duplicate of the same sequence", () => {
    const afterFirst = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels },
    );
    const afterDuplicate = applyUnreadEvent(
      afterFirst,
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels },
    );
    const afterOlder = applyUnreadEvent(
      afterDuplicate,
      { conversationId: "channel-a", sequence: 3 },
      { conversations: channels },
    );
    expect(afterFirst).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
    expect(afterDuplicate).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
    expect(afterOlder).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
  });

  test("increments per new sequence across conversations", () => {
    let state = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 1 },
      { conversations: channels },
    );
    state = applyUnreadEvent(
      state,
      { conversationId: "channel-a", sequence: 2 },
      { conversations: channels },
    );
    state = applyUnreadEvent(
      state,
      { conversationId: "channel-b", sequence: 9 },
      { conversations: channels },
    );
    expect(state["channel-a"]).toBe(2);
    expect(state["channel-b"]).toBe(1);
    expect(state["channel-a:seq"]).toBe(2);
  });

  test("bumps a DM badge by its conversation id, even for a DM the list has not read yet", () => {
    // The user channel is already scoped to this viewer, and a DM event says it is one (the Agent
    // or member on the other side): a DM created after the last list fetch still bumps live.
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, kind: "direct" },
      { conversations: new Set() },
    );
    expect(next).toEqual({ "dm-conversation": 1, "dm-conversation:seq": 4 });
  });

  test("bumps a DM between members by its conversation id too", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-people", sequence: 2, kind: "direct" },
      { conversations: new Set() },
    );
    expect(next).toEqual({ "dm-people": 1, "dm-people:seq": 2 });
  });

  test("does not double-count a replayed DM event", () => {
    const seeded = { "dm-conversation": 1, "dm-conversation:seq": 4 };
    const next = applyUnreadEvent(
      seeded,
      { conversationId: "dm-conversation", sequence: 4, kind: "direct" },
      { conversations: new Set() },
    );
    expect(next).toEqual(seeded);
  });

  test("suppresses a DM event while that DM is the open conversation", () => {
    for (const event of [
      { conversationId: "dm-conversation", sequence: 4, kind: "direct" as const },
      { conversationId: "dm-conversation", sequence: 4, kind: "direct" as const },
    ])
      expect(
        applyUnreadEvent({}, event, {
          conversations: new Set(),
          openConversationId: "dm-conversation",
        }),
      ).toEqual({});
  });

  test("never counts a thread reply in a DM", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, kind: "direct", threadRootId: "r1" },
      { conversations: new Set() },
    );
    expect(next).toEqual({});
  });
});

describe("clearUnread", () => {
  test("clears the badge and records the read boundary", () => {
    const state = { "channel-a": 4, "channel-a:seq": 10, "channel-b": 1 };
    const next = clearUnread(state, "channel-a", 12);
    expect(next).toEqual({ "channel-b": 1, "channel-a:seq": 12 });
  });

  test("keeps the highest boundary the badge already counted when reopened without a sequence", () => {
    const state = { "channel-a": 4, "channel-a:seq": 10 };
    const next = clearUnread(state, "channel-a");
    expect(next).toEqual({ "channel-a:seq": 10 });
  });

  test("never moves the boundary backwards", () => {
    const state = { "channel-a:seq": 12 };
    const next = clearUnread(state, "channel-a", 5);
    expect(next).toEqual({ "channel-a:seq": 12 });
  });

  test("clears an Agent-keyed DM badge by Agent id", () => {
    const state = { "agent-1": 2, "agent-1:seq": 8 };
    const next = clearUnread(state, "agent-1", 9);
    expect(next).toEqual({ "agent-1:seq": 9 });
  });
});

describe("replaceUnreadCounts", () => {
  test("server counts win over local arithmetic; boundaries survive", () => {
    const local = {
      "channel-a": 2,
      "channel-a:seq": 8,
      "agent-1": 5,
    };
    const next = replaceUnreadCounts(local, [
      { id: "channel-a", unreadCount: 1 },
      { id: "agent-1" },
    ]);
    // `agent-1` had no server count (0 unread), so the stale local badge is dropped.
    expect(next).toEqual({ "channel-a": 1, "channel-a:seq": 8 });
  });

  test("a suppressed conversation keeps its boundary but no badge", () => {
    // A refresh must not re-raise the badge of the conversation already on screen.
    const next = replaceUnreadCounts(
      { "channel-a": 0, "channel-a:seq": 8, "channel-b": 0 },
      [
        { id: "channel-a", unreadCount: 3 },
        { id: "channel-b", unreadCount: 2 },
      ],
      new Set(["channel-a"]),
    );
    expect(next).toEqual({ "channel-b": 2, "channel-a:seq": 8 });
  });
});

describe("unread seeding after a single-list read", () => {
  // The Chat lists live for the whole session and a read moves only the local count, so a row's
  // `unreadCount` is as old as its list's last read. A re-read of one list must not bring back the
  // other list's old counts.
  const channels = (readAt: number, a: number) => ({
    readAt,
    rows: [{ id: "channel-a", unreadCount: a }],
  });
  const dms = (readAt: number, d: number) => ({ readAt, rows: [{ id: "dm-d", unreadCount: d }] });

  test("a list not read again keeps its live counts; the one read again takes the server's", () => {
    const last = [channels(1, 5), dms(1, 2)];
    // #a was read here (local 0); then only the DM list was read again.
    const keep = unreadIdsToKeep([channels(1, 5), dms(2, 3)], last);
    expect([...keep]).toEqual(["channel-a"]);
    const next = replaceUnreadCounts(
      { "dm-d": 2 },
      [
        { id: "channel-a", unreadCount: 5 },
        { id: "dm-d", unreadCount: 3 },
      ],
      new Set(),
      keep,
    );
    expect(next).toEqual({ "dm-d": 3 });
  });

  test("a row whose own count changed (a mark-unread) takes it, read again or not", () => {
    expect([...unreadIdsToKeep([channels(1, 1), dms(1, 2)], [channels(1, 0), dms(1, 2)])]).toEqual([
      "dm-d",
    ]);
  });

  test("the first seed keeps nothing", () => {
    expect([...unreadIdsToKeep([channels(1, 5), dms(1, 2)], undefined)]).toEqual([]);
  });
});

describe("latestTopLevelSequence", () => {
  test("ignores thread replies", () => {
    expect(
      latestTopLevelSequence([
        { sequence: 1 },
        { sequence: 2, threadRootId: "root" },
        { sequence: 3 },
        { sequence: 4, threadRootId: "root" },
      ]),
    ).toBe(3);
  });

  test("is zero for an empty page", () => {
    expect(latestTopLevelSequence([])).toBe(0);
  });
});

describe("decodeMessageAvailableEvent", () => {
  test("accepts the additive workspace and thread fields", () => {
    const event = decodeMessageAvailableEvent({
      type: "message.available.v1",
      conversationId: "c1",
      messageId: "m1",
      sequence: 3,
      workspaceId: "w1",
      threadRootId: "r1",
    });
    expect(event.workspaceId).toBe("w1");
    expect(event.threadRootId).toBe("r1");
    expect(event.agentId).toBeUndefined();
  });

  test("accepts the additive direct-message agent field", () => {
    const event = decodeMessageAvailableEvent({
      type: "message.available.v1",
      conversationId: "c1",
      messageId: "m1",
      sequence: 3,
      agentId: "a1",
    });
    expect(event.agentId).toBe("a1");
  });

  test("rejects a non-string workspaceId", () => {
    expect(() =>
      decodeMessageAvailableEvent({
        type: "message.available.v1",
        conversationId: "c1",
        messageId: "m1",
        sequence: 3,
        workspaceId: 42,
      }),
    ).toThrow("invalid conversation event");
  });

  test("rejects a non-string agentId", () => {
    expect(() =>
      decodeMessageAvailableEvent({
        type: "message.available.v1",
        conversationId: "c1",
        messageId: "m1",
        sequence: 3,
        agentId: 42,
      }),
    ).toThrow("invalid conversation event");
  });
});

test("conversation channel naming", () => {
  expect(workspaceConversationChannel("w-1")).toBe("chat:workspace:w-1");
  expect(userConversationChannel("u-1")).toBe("chat:user:u-1");
});

describe("persistReadCursor", () => {
  test("returns after the first success", async () => {
    const calls: number[] = [];
    await persistReadCursor(async () => {
      calls.push(1);
    }, "channel:c1");
    expect(calls).toHaveLength(1);
  });

  test("retries once after a transient failure", async () => {
    let attempts = 0;
    await persistReadCursor(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("502");
    }, "channel:c1");
    expect(attempts).toBe(2);
  });

  test("gives up after the retry and warns instead of throwing", async () => {
    let attempts = 0;
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      await persistReadCursor(async () => {
        attempts += 1;
        throw new Error("502");
      }, "agent:a1");
    } finally {
      console.warn = original;
    }
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain("read cursor did not persist");
  });
});

describe("a read cursor moved on another page or device", () => {
  const ids = { workspaceId: "workspace-a", conversationId: "channel-a" };
  const marked = {
    type: "channel.marked.v1" as const,
    ...ids,
    unreadCount: 0,
    readThroughSequence: 9,
  };

  test("moves the conversation's stored window there, and the page's own at once when it is not open", () => {
    expect(storedCursorMove(marked, "channel-b")).toEqual({
      kind: "channel",
      conversationId: "channel-a",
      throughSequence: 9,
      adoptNow: true,
    });
    expect(
      storedCursorMove({ ...marked, type: "dm.marked.v1", conversationId: "dm-a" }, undefined),
    ).toEqual({ kind: "direct", conversationId: "dm-a", throughSequence: 9, adoptNow: true });
  });

  test("leaves the open conversation's divider where it opened until the person leaves it", () => {
    expect(storedCursorMove(marked, "channel-a").adoptNow).toBe(false);
  });
});

describe("a person's own message", () => {
  const own = { conversationId: "channel-a", sequence: 4, senderUserId: "viewer" };

  test("never bumps their badge, from any page or device", () => {
    const conversations = new Set(["channel-a"]);
    expect(applyUnreadEvent({}, own, { conversations, viewerId: "viewer" })).toEqual({
      "channel-a:seq": 4,
    });
    expect(
      applyUnreadEvent(
        {},
        { ...own, senderUserId: "someone" },
        { conversations, viewerId: "viewer" },
      ),
    ).toEqual({ "channel-a": 1, "channel-a:seq": 4 });
    // An event without a sender (an Agent, or an older server) counts as before.
    const { senderUserId: _unused, ...unnamed } = own;
    void _unused;
    expect(applyUnreadEvent({}, unnamed, { conversations, viewerId: "viewer" })).toEqual({
      "channel-a": 1,
      "channel-a:seq": 4,
    });
  });

  test("still sets the high-water, so the same message sent again without a sender never counts", () => {
    // A Task change re-sends its message at the original sequence, naming no sender.
    const conversations = new Set(["channel-a"]);
    const skipped = applyUnreadEvent({}, own, { conversations, viewerId: "viewer" });
    expect(skipped).toEqual({ "channel-a:seq": 4 });
    const { senderUserId: _unused, ...resent } = own;
    void _unused;
    expect(applyUnreadEvent(skipped, resent, { conversations, viewerId: "viewer" })).toBe(skipped);
  });

  test("never brings a closed chat back, so no list is re-read for it", () => {
    // The server brings a closed chat back only for someone else's message.
    expect(closedConversationLists(own, new Set(), "viewer")).toEqual([]);
    expect(
      closedConversationLists({ ...own, senderUserId: "someone" }, new Set(), "viewer"),
    ).toEqual(["channels"]);
  });
});
