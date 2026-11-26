import { describe, expect, test } from "bun:test";

import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { requireUserMayPostInChannel } from "#src/server/conversations/channel-post-access.server";
import { sendChannel } from "#src/server/conversations/channel-send.server";
import {
  announceMessage,
  type AnnounceMessageSnapshot,
} from "#src/server/conversations/conversation-activity.server";
import { storeMessageBody } from "#src/server/conversations/message-references.server";
import { pendingMentionActionsForMessage } from "#src/server/conversations/pending-mention-views.server";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("announceMessage snapshot fast path", () => {
  test("skips db.message.findUnique and overlaps messageAvailable with activityRecipients", async () => {
    let messageFindUniqueCalls = 0;
    const availableGate = deferred<void>();
    const recipientsGate = deferred<void>();
    let availableStarted = false;
    let recipientsStarted = false;
    const buckets: Array<{ userIds: readonly string[]; event: ConversationActivityEvent }> = [];

    const user2Id = "22222222-2222-4222-8222-222222222222";

    const db = {
      $queryRaw: async () => [],
      message: {
        findUnique: async () => {
          messageFindUniqueCalls += 1;
          return null;
        },
      },
      conversationMember: {
        findMany: async () => {
          recipientsStarted = true;
          if (availableStarted) {
            availableGate.resolve();
            recipientsGate.resolve();
          }
          await recipientsGate.promise;
          return [
            { id: "m-1", userId: "user-1", notificationLevel: "all" },
            { id: "m-2", userId: user2Id, notificationLevel: "all" },
            { id: "m-3", userId: "user-3", notificationLevel: "muted" },
          ];
        },
      },
    } as unknown as PrismaClient;

    const snapshot: AnnounceMessageSnapshot = {
      body: `hello <@human:${user2Id}>`,
      createdAt: new Date("2026-11-25T10:00:00.000Z"),
      threadRootId: null,
      workspaceId: "ws-1",
      conversation: { channelName: "general", kind: null },
      sender: {
        userId: "user-1",
        agentId: null,
        user: { displayName: "Alice", username: "alice" },
        agent: null,
      },
      mentions: [
        {
          kind: "user",
          actorId: user2Id,
          handle: "bob",
          member: { user: { displayName: "Bob" }, agent: null },
        },
      ],
      forwards: [],
      systemMessage: null,
      actionCard: null,
    };

    await announceMessage(
      db,
      {
        messageAvailable: async () => {
          availableStarted = true;
          if (recipientsStarted) {
            availableGate.resolve();
            recipientsGate.resolve();
          }
          await availableGate.promise;
        },
        conversationActivity: async (bucket) => {
          buckets.push(bucket);
        },
      },
      {
        conversationId: "conv-1",
        messageId: "msg-1",
        sequence: 7,
        workspaceId: "ws-1",
        senderUserId: "user-1",
      },
      snapshot,
    );

    expect(messageFindUniqueCalls).toBe(0);
    expect(buckets).toHaveLength(3);
    expect(buckets.find((b) => b.event.mentioned)?.userIds).toEqual([user2Id]);
    expect(buckets.find((b) => b.event.muted)?.userIds).toEqual(["user-3"]);
    expect(buckets.find((b) => !b.event.mentioned && !b.event.muted)?.event).toMatchObject({
      kind: "channel",
      preview: "hello @Bob",
      sender: { kind: "user", name: "Alice" },
      senderUserId: "user-1",
    });
  });

  test("returns after messageAvailable without DB queries for task_thread snapshots", async () => {
    let messageFindUniqueCalls = 0;
    let memberFindManyCalls = 0;
    let activityCalls = 0;
    let availableDone = false;

    const db = {
      $queryRaw: async () => [],
      message: {
        findUnique: async () => {
          messageFindUniqueCalls += 1;
          return null;
        },
      },
      conversationMember: {
        findMany: async () => {
          memberFindManyCalls += 1;
          return [];
        },
      },
    } as unknown as PrismaClient;

    await announceMessage(
      db,
      {
        messageAvailable: async () => {
          availableDone = true;
        },
        conversationActivity: async () => {
          activityCalls += 1;
        },
      },
      {
        conversationId: "conv-task",
        messageId: "msg-task",
        sequence: 1,
        workspaceId: "ws-1",
      },
      {
        body: "task note",
        createdAt: new Date("2026-11-25T10:00:00.000Z"),
        threadRootId: null,
        workspaceId: "ws-1",
        conversation: { channelName: null, kind: "task_thread" },
        sender: null,
        mentions: [],
        forwards: [],
        systemMessage: null,
        actionCard: null,
      },
    );

    expect(availableDone).toBe(true);
    expect(messageFindUniqueCalls).toBe(0);
    expect(memberFindManyCalls).toBe(0);
    expect(activityCalls).toBe(0);
  });
});

describe("requireUserMayPostInChannel concurrency", () => {
  test("queries channel access and active conversation member concurrently", async () => {
    const channelGate = deferred<void>();
    const memberGate = deferred<void>();
    let channelStarted = false;
    let memberStarted = false;

    const db = {
      workspaceMembership: {
        findUnique: async () => ({ userId: "user-1", role: "member" }),
      },
      conversation: {
        findFirst: async () => {
          channelStarted = true;
          if (memberStarted) {
            channelGate.resolve();
            memberGate.resolve();
          }
          await channelGate.promise;
          return {
            id: "conv-1",
            workspaceId: "ws-1",
            channelName: "general",
            visibility: "public",
            archivedAt: null,
            hiddenFromWorkspaceAt: null,
          };
        },
      },
      conversationMember: {
        findFirst: async () => {
          memberStarted = true;
          if (channelStarted) {
            channelGate.resolve();
            memberGate.resolve();
          }
          await memberGate.promise;
          return {
            id: "member-1",
            userId: "user-1",
            leftAt: null,
            user: {
              id: "user-1",
              username: "alice",
              displayName: "Alice",
              avatarObjectKey: null,
              description: "",
            },
          };
        },
      },
    } as unknown as PrismaClient;

    const result = await requireUserMayPostInChannel(db, "ws-1", "user-1", "conv-1");
    expect(result.channel.id).toBe("conv-1");
    expect(result.member.id).toBe("member-1");
  });
});

describe("sendChannel plain-message fast path", () => {
  test("skips post-commit message reload, pending mention query, and delivery publish when created plain", async () => {
    let findFirstOrThrowCalls = 0;
    let messageFindUniqueCalls = 0;
    let pendingActionFindManyCalls = 0;
    let publishBatchCalls = 0;
    const activities: ConversationActivityEvent[] = [];
    const createdAt = new Date("2026-11-25T10:00:00.000Z");

    const tx = {
      $executeRaw: async () => 1,
      $queryRaw: async () => [{ next: 12 }],
      conversation: {
        findFirst: async () => null,
      },
      conversationMember: {
        findMany: async () => [],
      },
      message: {
        create: async () => ({
          id: "msg-12",
          workspaceId: "ws-1",
          conversationId: "conv-1",
          senderMemberId: "member-1",
          threadRootId: null,
          body: "hello plain",
          sequence: 12,
          createdAt,
        }),
      },
    };

    const db = {
      $transaction: async <T>(fn: (client: typeof tx) => Promise<T>) => fn(tx),
      $queryRaw: async () => [],
      workspaceMembership: {
        findUnique: async () => ({ userId: "user-1", role: "member" }),
      },
      conversation: {
        findFirst: async () => ({
          id: "conv-1",
          workspaceId: "ws-1",
          channelName: "general",
          visibility: "public",
          archivedAt: null,
          hiddenFromWorkspaceAt: null,
        }),
      },
      conversationMember: {
        findFirst: async () => ({
          id: "member-1",
          userId: "user-1",
          leftAt: null,
          user: {
            id: "user-1",
            username: "alice",
            displayName: "Alice",
            avatarObjectKey: null,
            description: "Engineer",
          },
        }),
        findMany: async () => [{ id: "member-1", userId: "user-1", notificationLevel: "all" }],
      },
      message: {
        findFirstOrThrow: async () => {
          findFirstOrThrowCalls += 1;
          throw new Error("should not reload plain newly created message");
        },
        findUnique: async () => {
          messageFindUniqueCalls += 1;
          throw new Error("should not reload message in announceMessage");
        },
      },
      pendingMentionAction: {
        findMany: async () => {
          pendingActionFindManyCalls += 1;
          return [];
        },
      },
    } as unknown as PrismaClient;

    const sent = await sendChannel(
      {
        db,
        idempotency: {
          execute: async (_scope, persist) => persist(),
        },
        realtime: {
          messageAvailable: async () => {},
          conversationActivity: async ({ event }) => {
            activities.push(event);
          },
          memberChanged: async () => {},
        },
        publisher: {
          publishBatch: async () => {
            publishBatchCalls += 1;
            return [];
          },
        } as unknown as CentrifugoServerApi,
      },
      {
        workspaceId: "ws-1",
        userId: "user-1",
        channelId: "conv-1",
        idempotencyKey: "req-plain-1",
        body: "hello plain",
      },
    );

    expect(findFirstOrThrowCalls).toBe(0);
    expect(messageFindUniqueCalls).toBe(0);
    expect(pendingActionFindManyCalls).toBe(0);
    expect(publishBatchCalls).toBe(0);
    expect(sent).toMatchObject({
      id: "msg-12",
      sequence: 12,
      body: "hello plain",
      attachments: [],
      mentions: [],
      reactions: [],
      reactionVersion: 0,
      forwards: [],
      systemMessage: null,
      deliveries: [],
      unresolvedMentionHandles: [],
      pendingMentionActions: [],
    });
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      kind: "channel",
      preview: "hello plain",
      sender: { kind: "user", name: "Alice" },
    });
  });
});

describe("pendingMentionActionsForMessage scalar check", () => {
  test("queries scalar ids first without nested relation selects when no pending actions exist", async () => {
    const selects: unknown[] = [];
    const db = {
      pendingMentionAction: {
        findMany: async (args: { select?: unknown }) => {
          selects.push(args.select);
          return [];
        },
      },
      conversationMember: {
        findMany: async () => [],
      },
    } as unknown as Pick<PrismaClient, "pendingMentionAction" | "conversationMember">;

    const result = await pendingMentionActionsForMessage(
      db,
      {
        id: "msg-1",
        workspaceId: "ws-1",
        conversationId: "conv-1",
        senderMemberId: "member-1",
        body: "plain body",
      },
      { archivedAt: null, channelName: "general", visibility: "public" },
    );

    expect(result).toEqual([]);
    expect(selects).toEqual([{ id: true }]);
  });
});

describe("storeMessageBody batched reference resolution", () => {
  test("batches multi-channel thread anchors into one query without concurrent tx calls", async () => {
    let inFlightTxQueries = 0;
    let maxConcurrentTxQueries = 0;
    let anchorQueryCalls = 0;

    async function trackTx<T>(fn: () => T): Promise<T> {
      inFlightTxQueries += 1;
      maxConcurrentTxQueries = Math.max(maxConcurrentTxQueries, inFlightTxQueries);
      await Promise.resolve();
      try {
        return fn();
      } finally {
        inFlightTxQueries -= 1;
      }
    }

    const tx = {
      task: {
        findMany: () => trackTx(() => [{ id: "task-1", number: 1 }]),
      },
      conversation: {
        findMany: () =>
          trackTx(() => [
            { id: "ch-ops", channelName: "ops" },
            { id: "ch-eng", channelName: "eng" },
          ]),
      },
      message: {
        findMany: () => {
          anchorQueryCalls += 1;
          return trackTx(() => [
            { id: "aaaa1111-0000-4000-8000-000000000001", conversationId: "ch-ops" },
            { id: "bbbb2222-0000-4000-8000-000000000002", conversationId: "ch-eng" },
          ]);
        },
      },
    } as unknown as Prisma.TransactionClient;

    const stored = await storeMessageBody(
      tx,
      { workspaceId: "ws-1", conversationId: "conv-1", reader: { userId: "user-1" } },
      "Hey @bob check task #1 in #ops:aaaa1111 and #eng:bbbb2222",
      {
        targets: () =>
          trackTx(() => [{ key: "m-bob", type: "user" as const, id: "user-bob", handle: "bob" }]),
      },
    );

    expect(anchorQueryCalls).toBe(1);
    expect(maxConcurrentTxQueries).toBe(1);
    expect(stored.mentions).toHaveLength(1);
    expect(stored.body).toContain("<@human:user-bob>");
    expect(stored.body).toContain("<@task:1>");
    expect(stored.body).toContain("<@thread:ch-ops:aaaa1111-0000-4000-8000-000000000001:ops>");
    expect(stored.body).toContain("<@thread:ch-eng:bbbb2222-0000-4000-8000-000000000002:eng>");
  });
});
