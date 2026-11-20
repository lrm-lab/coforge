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

describe("sidebar message unread updates", () => {
  const marked = {
    type: "channel.marked.v1",
    workspaceId: "w1",
    conversationId: "c1",
    unreadCount: 3,
    readThroughSequence: 15,
    unreadThreadCount: 2,
    threadMentioned: true,
  } as const;

  test("a channel marked event updates message fields without applying its thread snapshot", () => {
    expect(applyMarkedUnreadFields(marked, { isOpenChannel: false })).toEqual({
      unreadCount: 3,
      mentioned: false,
      markedUnread: false,
    });
  });

  test("opening a channel clears its message unread count, mention and manual mark", () => {
    expect(
      applyMarkedUnreadFields(
        { ...marked, mentioned: true, markedUnread: true },
        { isOpenChannel: true },
      ),
    ).toEqual({ unreadCount: 0, mentioned: false, markedUnread: false });
  });

  test("a new mention marks a closed channel when another member sent it", () => {
    const mention = { mentioned: true };
    expect(
      applyActivityUnreadFields(false, mention, { isOpenChannel: false, isOwnMessage: false }),
    ).toBe(true);
    expect(
      applyActivityUnreadFields(false, mention, { isOpenChannel: true, isOwnMessage: false }),
    ).toBe(false);
    expect(
      applyActivityUnreadFields(false, mention, { isOpenChannel: false, isOwnMessage: true }),
    ).toBe(false);
  });
});
