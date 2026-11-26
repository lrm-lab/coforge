import { describe, expect, test } from "bun:test";

import { canMarkUnread, doneTarget } from "#src/features/inbox/activity-item-kind";
import type {
  ActivityArtifactItem,
  ActivityConversationItem,
} from "#src/server/inbox/activity-inbox.server";

function conversationItem(
  overrides: Partial<ActivityConversationItem> = {},
): ActivityConversationItem {
  return {
    kind: "conversation",
    key: "conv-key",
    place: {
      kind: "channel",
      conversationId: "chan-1",
      channelName: "general",
      visibility: "PUBLIC",
      members: [],
    },
    thread: null,
    task: null,
    latest: { id: "msg-latest" } as ActivityConversationItem["latest"],
    latestSequence: 12,
    unreadCount: 0,
    firstUnreadMessageId: null,
    unreadMention: false,
    firstMentionMessageId: null,
    mentionAction: null,
    attachmentComment: null,
    pinned: false,
    ...overrides,
  } as unknown as ActivityConversationItem;
}

function artifactItem(overrides: Partial<ActivityArtifactItem> = {}): ActivityArtifactItem {
  return {
    kind: "artifact",
    key: "artifact-key",
    at: new Date("2026-10-01T12:00:00.000Z"),
    artifact: { id: "art-1", title: "Spec", entryPath: "index.html" },
    event: {
      kind: "comment",
      mentioned: false,
      preview: "Looks good",
      imageCount: 0,
      reviewComments: 0,
      version: 1,
      actor: { id: "user-1", kind: "user", name: "Ada" },
    },
    target: { kind: "channel", id: "chan-1", label: "general" },
    unreadCount: 1,
    unreadMention: false,
    ...overrides,
  } as unknown as ActivityArtifactItem;
}

describe("canMarkUnread", () => {
  test("allows channels, DMs, ordinary threads, and mention actions", () => {
    expect(canMarkUnread(conversationItem())).toBe(true);
    expect(
      canMarkUnread(
        conversationItem({
          place: {
            kind: "direct",
            conversationId: "dm-1",
            peer: { id: "u2", name: "Bob" } as never,
          },
        }),
      ),
    ).toBe(true);
    expect(
      canMarkUnread(
        conversationItem({
          thread: { root: { id: "root-1" } as never, task: null },
        }),
      ),
    ).toBe(true);
    expect(
      canMarkUnread(
        conversationItem({
          mentionAction: { resolutionId: "res-1", threadRootId: "root-1" },
          thread: { root: { id: "root-1" } as never, task: null },
        }),
      ),
    ).toBe(true);
  });

  test("disallows task items, task threads, and artifact items", () => {
    expect(
      canMarkUnread(
        conversationItem({
          task: { number: 7, conversationId: "chan-1" } as ActivityConversationItem["task"],
        }),
      ),
    ).toBe(false);
    expect(
      canMarkUnread(
        conversationItem({
          thread: {
            root: { id: "root-1" } as never,
            task: { number: 9 } as NonNullable<ActivityConversationItem["thread"]>["task"],
          },
        }),
      ),
    ).toBe(false);
    expect(canMarkUnread(artifactItem())).toBe(false);
  });
});

describe("doneTarget", () => {
  test("forwards markedUnreadVersion only when present on thread items", () => {
    expect(
      doneTarget(
        conversationItem({
          thread: { root: { id: "root-1" } as never, task: null },
          latestSequence: 18,
          markedUnreadVersion: "mark-v1",
        }),
      ),
    ).toEqual({
      kind: "thread",
      conversationId: "chan-1",
      rootMessageId: "root-1",
      throughSequence: 18,
      markedUnreadVersion: "mark-v1",
    });

    const withoutMark = doneTarget(
      conversationItem({
        thread: { root: { id: "root-1" } as never, task: null },
        latestSequence: 18,
      }),
    );
    expect(withoutMark).toEqual({
      kind: "thread",
      conversationId: "chan-1",
      rootMessageId: "root-1",
      throughSequence: 18,
    });
    expect("markedUnreadVersion" in withoutMark).toBe(false);
  });

  test("builds targets for mention actions, tasks, conversations, and artifacts", () => {
    expect(
      doneTarget(
        conversationItem({
          mentionAction: { resolutionId: "res-1", threadRootId: null },
        }),
      ),
    ).toEqual({ kind: "mention_action", resolutionId: "res-1" });

    expect(
      doneTarget(
        conversationItem({
          task: { number: 4, conversationId: "task-host-conv" } as never,
          latestSequence: 25,
        }),
      ),
    ).toEqual({
      kind: "conversation",
      conversationId: "task-host-conv",
      throughSequence: 25,
    });

    expect(doneTarget(artifactItem())).toEqual({
      kind: "artifact",
      artifactId: "art-1",
      throughAt: new Date("2026-10-01T12:00:00.000Z").getTime(),
    });
  });
});
