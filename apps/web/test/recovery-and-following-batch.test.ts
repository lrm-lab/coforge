import { describe, expect, test } from "bun:test";
import {
  channelTaskReferenceToken,
  dmTaskReferenceToken,
  readableBody,
} from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { taskReferenceViewForMessages } from "#src/server/conversations/task-reference-view.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { TaskConversations } from "#src/server/tasks/task-conversations.server";
import { RECOVERY_CREATED_AT, recoverySecondPassStubs } from "./helpers/recovery-second-pass-stubs";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("taskReferenceViewForMessages", () => {
  test("batches channel and DM task reference lookups across many messages in constant queries", async () => {
    const publicId = "11111111-1111-4111-8111-111111111111";
    const privateId = "22222222-2222-4222-8222-222222222222";
    const dmId = "33333333-3333-4333-8333-333333333333";
    let conversationQueries = 0;
    let memberQueries = 0;

    const db = {
      conversation: {
        findMany: async () => {
          conversationQueries += 1;
          return [{ id: publicId, visibility: "public", members: [] }];
        },
      },
      conversationMember: {
        findMany: async () => {
          memberQueries += 1;
          if (memberQueries === 1) return [{ conversationId: dmId, agentId: "agent-a" }];
          return [
            { conversationId: dmId, userId: null, agentId: "agent-a" },
            { conversationId: dmId, userId: null, agentId: "agent-b" },
          ];
        },
      },
      user: { findMany: async () => [] },
      agent: {
        findMany: async (args: { where: { id?: { in: string[] } } }) =>
          args.where.id ? [{ id: "agent-b", name: "beta" }] : [{ name: "beta" }],
      },
    } as unknown as Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">;

    const messages = [
      ...Array.from({ length: 18 }, (_, i) => ({
        conversationId: "conv-general",
        body: `check ${channelTaskReferenceToken(publicId, "ops", i + 1)} and ${channelTaskReferenceToken(privateId, "secret", 2)}`,
      })),
      { conversationId: "conv-general", body: dmTaskReferenceToken(dmId, "beta", 9) },
      { conversationId: dmId, body: dmTaskReferenceToken(dmId, "beta", 9) },
    ];

    const viewOf = await taskReferenceViewForMessages(db, "ws-1", "agent-a", messages);
    expect(viewOf).toBeDefined();
    expect(conversationQueries).toBe(1);
    expect(memberQueries).toBe(2);

    expect(
      readableBody(messages[0]!.body, {
        mention: () => undefined,
        task: viewOf!("conv-general"),
      }),
    ).toBe("check #ops:#1 and a task you cannot view");
    expect(
      readableBody(messages[18]!.body, {
        mention: () => undefined,
        task: viewOf!("conv-general"),
      }),
    ).toBe("dm:@beta:#9");
    expect(
      readableBody(messages[19]!.body, {
        mention: () => undefined,
        task: viewOf!(dmId),
      }),
    ).toBe("#9");

    conversationQueries = 0;
    memberQueries = 0;
    expect(
      await taskReferenceViewForMessages(db, "ws-1", "agent-a", [
        { conversationId: "conv-general", body: "plain text without task refs" },
      ]),
    ).toBeUndefined();
    expect(conversationQueries).toBe(0);
    expect(memberQueries).toBe(0);
  });
});

describe("batched Agent recovery and pending delivery task reference reads", () => {
  test("readAgentRecoveryContext batches taskReferenceViews across resume messages and overlaps with second pass", async () => {
    const publicId = "44444444-4444-4444-8444-444444444444";
    const body = `See ${channelTaskReferenceToken(publicId, "ops", 7)}`;
    const mentionsStarted = deferred<void>();
    const mentionsRelease = deferred<unknown[]>();
    let conversationStarted = false;
    let conversationQueries = 0;

    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`,
      sequence: i + 1,
      body,
      conversationId: "conv-1",
      threadRootId: null,
      senderMemberId: "member-1",
      createdAt: RECOVERY_CREATED_AT,
      deliveryId: `del-${i}`,
      senderAgentName: null,
      senderAgentDescription: null,
      senderUsername: "frank",
      senderUserDescription: "",
      channelName: "general",
      otherUsername: null,
      agentPeer: null,
      unreadCount: 20,
      globalRank: i + 1,
      nonMemberMention: false,
      attachmentId: null,
      conversationKind: null,
      directKey: null,
      appKey: null,
    }));

    const db = {
      ...recoverySecondPassStubs,
      messageMention: {
        findMany: () => {
          mentionsStarted.resolve();
          return mentionsRelease.promise;
        },
      },
      conversation: {
        findMany: async () => {
          conversationStarted = true;
          conversationQueries += 1;
          return [{ id: publicId, visibility: "public", members: [] }];
        },
      },
      conversationMember: { findMany: async () => [] },
      user: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      $queryRaw: async () => rows,
    } as unknown as PrismaClient;

    const pending = new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "ws-1",
      "agent-1",
    );

    try {
      await mentionsStarted.promise;
      expect(conversationStarted).toBe(true);
    } finally {
      mentionsRelease.resolve([]);
    }
    const result = await pending;
    expect(conversationQueries).toBe(1);
    expect(result.resumeMessages).toHaveLength(20);
    expect(String(result.resumeMessages[0]?.body)).toBe("See #ops:#7");
  });

  test("readPendingAgentDeliveries batches taskReferenceViews across pending deliveries", async () => {
    const publicId = "55555555-5555-4555-8555-555555555555";
    const body = `Track ${channelTaskReferenceToken(publicId, "ops", 12)}`;
    let conversationQueries = 0;
    let rawQueries = 0;

    const deliveries = Array.from({ length: 15 }, (_, i) => ({
      deliveryId: `del-${i}`,
      messageId: `msg-${i}`,
      conversationId: "conv-1",
      sequence: i + 1,
      reason: null,
      conversation: { channelName: "general", kind: null, members: [] },
      message: {
        createdAt: RECOVERY_CREATED_AT,
        body,
        threadRootId: null,
        sender: {
          agentId: null,
          agent: null,
          user: { username: "frank", description: "" },
        },
        mentions: [],
        forwards: [],
        attachments: [],
        actionCard: null,
        pendingMentionActions: [],
      },
    }));

    const db = {
      conversation: {
        findMany: async () => {
          conversationQueries += 1;
          return [{ id: publicId, visibility: "public", members: [] }];
        },
      },
      conversationMember: { findMany: async () => [] },
      user: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      $queryRaw: async () => {
        rawQueries += 1;
        return deliveries.map((d) => ({ deliveryId: d.deliveryId }));
      },
      agentMessageDelivery: { findMany: async () => deliveries },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
      "ws-1",
      "agent-1",
    );

    expect(rawQueries).toBe(2);
    expect(conversationQueries).toBe(1);
    expect(result).toHaveLength(15);
    expect(String(result[0]?.body)).toBe("Track #ops:#12");
  });
});

describe("TaskConversations.following batched unread counts", () => {
  test("computes unread counts in one batched SQL query and restricts channel member over-fetch", async () => {
    let findUniqueCalls = 0;
    let messageCountCalls = 0;
    let rawCalls = 0;
    const findManyCalls: Array<Record<string, unknown>> = [];

    const followedRows = [
      {
        reason: "assigned",
        createdAt: RECOVERY_CREATED_AT,
        task: {
          number: 1,
          title: "Channel task",
          status: "todo",
          discussionConversationId: "11111111-1111-4111-8111-111111111111",
          conversation: { channelName: "general", members: [] },
        },
      },
      {
        reason: "mentioned",
        createdAt: RECOVERY_CREATED_AT,
        task: {
          number: 2,
          title: "DM task",
          status: "in_progress",
          discussionConversationId: "22222222-2222-4222-8222-222222222222",
          conversation: { channelName: null, members: [{ user: { username: "frank" } }] },
        },
      },
      {
        reason: "manual",
        createdAt: RECOVERY_CREATED_AT,
        task: {
          number: 3,
          title: "No discussion yet",
          status: "todo",
          discussionConversationId: null,
          conversation: { channelName: "general", members: [] },
        },
      },
    ];

    const db = {
      taskFollow: {
        findMany: async (args: Record<string, unknown>) => {
          findManyCalls.push(args);
          return followedRows;
        },
      },
      conversationMember: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return null;
        },
      },
      message: {
        count: async () => {
          messageCountCalls += 1;
          return 0;
        },
      },
      $queryRaw: async () => {
        rawCalls += 1;
        return [
          { conversationId: "11111111-1111-4111-8111-111111111111", unread: 4 },
          { conversationId: "22222222-2222-4222-8222-222222222222", unread: 0 },
        ];
      },
    } as unknown as PrismaClient;

    const conversations = new TaskConversations({ db, reader: "agent", dependencies: {} });
    const result = await conversations.following({ workspaceId: "ws-1", agentId: "agent-1" });

    expect(findUniqueCalls).toBe(0);
    expect(messageCountCalls).toBe(0);
    expect(rawCalls).toBe(1);
    expect(result.map((row) => ({ taskRef: row.taskRef, unread: row.unread }))).toEqual([
      { taskRef: "#general:#1", unread: 4 },
      { taskRef: "dm:@frank:#2", unread: 0 },
      { taskRef: "#general:#3", unread: 0 },
    ]);

    const select = findManyCalls[0]!.select as {
      task: { select: { conversation: { select: { members: { where: unknown } } } } };
    };
    expect(select.task.select.conversation.select.members.where).toMatchObject({
      userId: { not: null },
      conversation: { channelName: null },
    });

    rawCalls = 0;
    const humanResult = await conversations.following({ workspaceId: "ws-1", userId: "user-1" });
    expect(rawCalls).toBe(0);
    expect(humanResult.every((row) => row.unread === 0)).toBe(true);
  });
});
