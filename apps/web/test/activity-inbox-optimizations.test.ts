import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { activityNavAttentionSql } from "#src/server/inbox/activity-inbox-page-sql.server";
import { hydrateConversationRows } from "#src/server/inbox/activity-inbox-conversation-hydrate.server";
import { markPublicChannelRead } from "#src/server/conversations/channel-read.server";
import { DirectConversations } from "#src/server/conversations/direct-conversations.server";
import { markHumanRead } from "#src/server/conversations/human-unread.server";

describe("Activity inbox and markRead optimizations", () => {
  test("activityNavAttentionSql omits pins, peer agent lookups, and thread mentions and filters unread notices", () => {
    const query = activityNavAttentionSql(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    );
    expect(query.sql).toMatch(/^\s*WITH items AS MATERIALIZED/);
    expect(query.sql).not.toContain('"conversation_pins"');
    expect(query.sql).not.toContain('am."agentId"');
    expect(query.sql).toContain('pma."targetReadAt" IS NULL');
    expect(query.sql).not.toContain("OFFSET 0");
  });

  test("hydrateConversationRows skips empty queries and returns immediately for empty rows", async () => {
    const calls: string[] = [];
    const db = {
      message: {
        findMany: async () => {
          calls.push("message.findMany");
          return [];
        },
      },
      agent: {
        findMany: async () => {
          calls.push("agent.findMany");
          return [];
        },
      },
      user: {
        findMany: async () => {
          calls.push("user.findMany");
          return [];
        },
      },
      task: {
        findMany: async () => {
          calls.push("task.findMany");
          return [];
        },
      },
      $queryRaw: async () => {
        calls.push("$queryRaw");
        return [];
      },
    } as unknown as PrismaClient;

    const empty = await hydrateConversationRows(db, "ws-1", "user-1", []);
    expect(empty).toEqual([]);
    expect(calls).toEqual([]);

    await hydrateConversationRows(db, "ws-1", "user-1", [
      {
        unreadItemCount: 1,
        unreadMentionItemCount: 0,
        unreadTaskItemCount: 0,
        activeItemCount: 1,
        key: "conversation:c-1",
        isPin: false,
        kind: "channel",
        memberId: "m-1",
        conversationId: "c-1",
        rootMessageId: null,
        channelName: "general",
        visibility: "public",
        directKey: null,
        agentId: null,
        latestMessageId: "msg-1",
        latestSequence: 1,
        latestAt: new Date("2026-01-01T00:00:00Z"),
        pastDone: true,
        hasUnread: true,
        pinOrder: null,
        pinnedAt: null,
        unreadMention: false,
        firstMentionMessageId: null,
        taskBoardId: null,
        taskNumber: null,
        taskTitle: null,
        mentionId: null,
        noticeThreadRootId: null,
        attachmentId: null,
        attachmentFileName: null,
        attachmentSourceMessageId: null,
        unreadCount: 1,
        firstUnreadMessageId: "msg-1",
        markedUnreadVersion: null,
      },
    ]);
    expect(calls).toEqual(["message.findMany", "$queryRaw"]);
  });

  test("markHumanRead skips unnecessary updateMany and skips recordReadAdvance when disabled", async () => {
    const calls: string[] = [];
    const makeDb = (
      member: {
        id: string;
        readThroughSequence: number;
        unreadFromSequence: number | null;
      },
      failGuardedUpdate = false,
    ) =>
      ({
        $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
          cb({
            message: {
              findFirst: async () => {
                calls.push("message.findFirst");
                return { sequence: 10 };
              },
            },
            conversationMember: {
              findFirst: async () => {
                calls.push("conversationMember.findFirst");
                return member;
              },
              updateMany: async (arg: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
              }) => {
                const guarded = "OR" in arg.where;
                calls.push(
                  `updateMany:${Object.keys(arg.data).join(",")}${guarded ? ":guarded" : ""}`,
                );
                if (guarded && failGuardedUpdate) return { count: 0 };
                return { count: 1 };
              },
            },
            conversation: {
              findUnique: async () => {
                calls.push("conversation.findUnique");
                return { directKey: null, workspaceId: "ws-1" };
              },
            },
          }),
      }) as unknown as PrismaClient;

    const moved = await markHumanRead(
      makeDb({ id: "m-1", readThroughSequence: 5, unreadFromSequence: null }),
      { conversationId: "c-1", userId: "u-1", throughSequence: 10 },
      { recordAdvance: false },
    );
    expect(moved).toMatchObject({ memberId: "m-1", readThroughAdvanced: true, unreadCount: 0 });
    expect(calls).toEqual([
      "message.findFirst",
      "conversationMember.findFirst",
      "updateMany:readThroughSequence:guarded",
    ]);

    calls.length = 0;
    const raced = await markHumanRead(
      makeDb({ id: "m-1", readThroughSequence: 5, unreadFromSequence: null }, true),
      { conversationId: "c-1", userId: "u-1", throughSequence: 10 },
      { recordAdvance: false },
    );
    expect(raced).toMatchObject({ memberId: "m-1", readThroughAdvanced: true, unreadCount: 0 });
    expect(calls).toEqual([
      "message.findFirst",
      "conversationMember.findFirst",
      "updateMany:readThroughSequence:guarded",
      "updateMany:readThroughSequence",
      "updateMany:unreadFromSequence",
    ]);

    calls.length = 0;
    const noop = await markHumanRead(
      makeDb({ id: "m-1", readThroughSequence: 10, unreadFromSequence: null }),
      { conversationId: "c-1", userId: "u-1", throughSequence: 10 },
      { recordAdvance: false },
    );
    expect(noop).toBeUndefined();
    expect(calls).toEqual(["message.findFirst", "conversationMember.findFirst"]);
  });

  test("markPublicChannelRead and DirectConversations.markRead fan out post-commit announcements in parallel", async () => {
    const createBarrier = (target: number) => {
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        enter: async () => {
          arrived += 1;
          if (arrived >= target) release();
          await gate;
        },
        release,
      };
    };

    const channelBarrier = createBarrier(3);
    const channelDb = {
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          message: { findFirst: async () => ({ sequence: 5 }) },
          conversationMember: {
            findFirst: async () => ({
              id: "m-1",
              readThroughSequence: 1,
              unreadFromSequence: null,
            }),
            updateMany: async () => ({ count: 1 }),
          },
        }),
      $queryRaw: async () => [],
    } as unknown as PrismaClient;

    try {
      await markPublicChannelRead({
        db: channelDb,
        realtime: {
          viewerChanged: async () => channelBarrier.enter(),
          conversationReadChanged: async () => channelBarrier.enter(),
          activityChanged: async () => channelBarrier.enter(),
        },
        authorize: async () => {},
        workspaceId: "ws-1",
        userId: "u-1",
        conversationId: "c-1",
        throughSequence: 5,
      });
    } finally {
      channelBarrier.release();
    }

    const dmBarrier = createBarrier(3);
    const dmKey = peopleDirectKey("u-1", "u-2");
    const dmDb = {
      conversation: {
        findFirst: async () => ({
          directKey: dmKey,
          members: [{ id: "m-1", userId: "u-1", agent: null }],
        }),
      },
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          message: { findFirst: async () => ({ sequence: 5 }) },
          conversationMember: {
            findFirst: async () => ({
              id: "m-1",
              readThroughSequence: 1,
              unreadFromSequence: null,
            }),
            updateMany: async () => ({ count: 1 }),
          },
          conversation: {
            findUnique: async () => ({ directKey: dmKey, workspaceId: "ws-1" }),
          },
          messageRead: {
            findFirst: async () => null,
            create: async () => ({}),
          },
        }),
      $queryRaw: async () => [],
    } as unknown as PrismaClient;

    try {
      await new DirectConversations(dmDb, {
        viewerChanged: async () => dmBarrier.enter(),
        conversationReadChanged: async () => dmBarrier.enter(),
        activityChanged: async () => dmBarrier.enter(),
      }).markRead("ws-1", "u-1", "c-1", 5);
    } finally {
      dmBarrier.release();
    }
  });
});
