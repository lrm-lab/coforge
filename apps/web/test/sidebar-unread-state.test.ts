import { describe, expect, test } from "bun:test";
import {
  applyActivityUnreadFields,
  applyMarkedUnreadFields,
  channelHasAnyUnread,
  directHasAnyUnread,
  formatUnreadCap,
  sidebarRowIndicators,
} from "#src/features/conversations/sidebar-unread-state";
import { conversationRowMenuItems } from "#src/features/conversations/conversation-row-menu-model";

describe("sidebarRowIndicators (Raft conversation list rules)", () => {
  test("all-read joined channel is not bold and shows no markers", () => {
    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: true,
        muted: false,
        unreadCount: 0,
      }),
    ).toEqual({
      bold: false,
      showMention: false,
      unreadLabel: null,
      threadLabel: null,
      subduedCapsule: false,
      showManualDot: false,
    });
  });

  test("only unread top-level messages: bold row + prominent single-segment number pill, capped at 99+", () => {
    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: true,
        muted: false,
        unreadCount: 4,
      }),
    ).toEqual({
      bold: true,
      showMention: false,
      unreadLabel: "4",
      threadLabel: null,
      subduedCapsule: false,
      showManualDot: false,
    });
    expect(formatUnreadCap(100)).toBe("99+");
    expect(formatUnreadCap(99)).toBe("99");
  });

  test("only unread followed threads: bold row + thread-only capsule segment", () => {
    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: true,
        muted: false,
        unreadCount: 0,
        unreadThreadCount: 2,
      }),
    ).toEqual({
      bold: true,
      showMention: false,
      unreadLabel: null,
      threadLabel: "2",
      subduedCapsule: false,
      showManualDot: false,
    });
  });

  test("both unread messages and unread threads share one capsule and @ shows from either source", () => {
    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: true,
        muted: false,
        unreadCount: 120,
        unreadThreadCount: 3,
        mentioned: false,
        threadMentioned: true,
      }),
    ).toEqual({
      bold: true,
      showMention: true,
      unreadLabel: "99+",
      threadLabel: "3",
      subduedCapsule: false,
      showManualDot: false,
    });
  });

  test("muted or unjoined channels are NEVER bold, subdue the capsule, and STILL show @ when mentioned", () => {
    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: true,
        muted: true,
        unreadCount: 5,
        unreadThreadCount: 2,
        mentioned: false,
        threadMentioned: true,
      }),
    ).toEqual({
      bold: false,
      showMention: true,
      unreadLabel: "5",
      threadLabel: "2",
      subduedCapsule: true,
      showManualDot: false,
    });

    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: false,
        muted: false,
        unreadCount: 3,
      }),
    ).toEqual({
      bold: false,
      showMention: false,
      unreadLabel: "3",
      threadLabel: null,
      subduedCapsule: true,
      showManualDot: false,
    });
  });

  test("manually marked-unread channel with zero count is bold (when audible) and shows small dot", () => {
    expect(
      sidebarRowIndicators({
        kind: "channel",
        joined: true,
        muted: false,
        unreadCount: 0,
        unreadThreadCount: 0,
        markedUnread: true,
      }),
    ).toEqual({
      bold: true,
      showMention: false,
      unreadLabel: null,
      threadLabel: null,
      subduedCapsule: false,
      showManualDot: true,
    });
  });

  test("DM rows show ONLY number badge (99+), never thread badge and never @", () => {
    expect(
      sidebarRowIndicators({
        kind: "direct",
        muted: false,
        unreadCount: 105,
      }),
    ).toEqual({
      bold: true,
      showMention: false,
      unreadLabel: "99+",
      threadLabel: null,
      subduedCapsule: false,
      showManualDot: false,
    });

    expect(
      sidebarRowIndicators({
        kind: "direct",
        muted: true,
        unreadCount: 2,
      }),
    ).toEqual({
      bold: false,
      showMention: false,
      unreadLabel: "2",
      threadLabel: null,
      subduedCapsule: true,
      showManualDot: false,
    });
  });
});

describe("right-click menu mark-read / mark-unread toggle", () => {
  test("offers mark-read when channel or DM has any unread (including thread unread), else mark-unread", () => {
    expect(channelHasAnyUnread({ unreadCount: 0, unreadThreadCount: 1, markedUnread: false })).toBe(
      true,
    );
    expect(channelHasAnyUnread({ unreadCount: 0, unreadThreadCount: 0, markedUnread: false })).toBe(
      false,
    );
    expect(directHasAnyUnread({ unreadCount: 2, markedUnread: false })).toBe(true);
    expect(directHasAnyUnread({ unreadCount: 0, markedUnread: false })).toBe(false);

    expect(
      conversationRowMenuItems({ kind: "channel", pinned: false, muted: false, hasUnread: true })[0]
        ?.id,
    ).toBe("mark-read");
    expect(
      conversationRowMenuItems({
        kind: "channel",
        pinned: false,
        muted: false,
        hasUnread: false,
      })[0]?.id,
    ).toBe("mark-unread");
  });
});

describe("realtime partial updates treat omitted fields as 0/false", () => {
  test("reading the last unread thread clears unreadThreadCount from 1 to 0 and removes @ when omitted on channel.marked.v1", () => {
    const before = {
      unreadCount: 0,
      mentioned: false,
      markedUnread: false,
      unreadThreadCount: 1,
      threadMentioned: true,
    };
    const afterThreadRead = applyMarkedUnreadFields(
      before,
      {
        type: "channel.marked.v1",
        workspaceId: "w1",
        conversationId: "c1",
        unreadCount: 0,
        readThroughSequence: 10,
      },
      { isOpenChannel: false },
    );
    expect(afterThreadRead).toEqual({
      unreadCount: 0,
      mentioned: false,
      markedUnread: false,
      unreadThreadCount: 0,
      threadMentioned: false,
    });
  });

  test("opening a channel clears top-level unread/mention/markedUnread while keeping thread unread and thread @", () => {
    const before = {
      unreadCount: 3,
      mentioned: true,
      markedUnread: true,
      unreadThreadCount: 2,
      threadMentioned: true,
    };
    const afterChannelOpen = applyMarkedUnreadFields(
      before,
      {
        type: "channel.marked.v1",
        workspaceId: "w1",
        conversationId: "c1",
        unreadCount: 0,
        readThroughSequence: 15,
        unreadThreadCount: 2,
        threadMentioned: true,
      },
      { isOpenChannel: true },
    );
    expect(afterChannelOpen).toEqual({
      unreadCount: 0,
      mentioned: false,
      markedUnread: false,
      unreadThreadCount: 2,
      threadMentioned: true,
    });
  });

  test("conversation.activity.v1 updates top-level @ and thread counts, treating omitted threadMentioned as false", () => {
    const base = {
      mentioned: false,
      unreadThreadCount: 1,
      threadMentioned: true,
    };
    const afterThreadEventWithoutMention = applyActivityUnreadFields(
      base,
      {
        conversationId: "c1",
        threadRootId: "r2",
        unreadThreadCount: 0,
      },
      { isOpenChannel: false, openThreadRootId: undefined, isOwnMessage: false },
    );
    expect(afterThreadEventWithoutMention).toEqual({
      mentioned: false,
      unreadThreadCount: 0,
      threadMentioned: false,
    });

    const afterTopLevelMention = applyActivityUnreadFields(
      { mentioned: false, unreadThreadCount: 2, threadMentioned: false },
      {
        conversationId: "c1",
        mentioned: true,
      },
      { isOpenChannel: false, openThreadRootId: undefined, isOwnMessage: false },
    );
    expect(afterTopLevelMention).toEqual({
      mentioned: true,
      unreadThreadCount: 2,
      threadMentioned: false,
    });
  });
});
