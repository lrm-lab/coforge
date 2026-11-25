import { describe, expect, test } from "bun:test";
import {
  channelTaskReferenceToken,
  dmTaskReferenceToken,
  readableBody,
} from "@lrm/coforge-sdk/internal";

import type { ConversationActivityEvent } from "#src/features/conversations/conversation-activity-event";
import type { PrismaClient } from "#src/generated/prisma/client";
import type { CentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import {
  AgentDeliveryPublisher,
  type AgentDeliveryPush,
} from "#src/server/conversations/agent-delivery.server";
import { sendChannel } from "#src/server/conversations/channel-send.server";
import { announceMessage } from "#src/server/conversations/conversation-activity.server";
import { CentrifugoConversationRealtime } from "#src/server/conversations/conversation-realtime.server";
import {
  taskReferenceView,
  taskReferenceViews,
} from "#src/server/conversations/task-reference-view.server";

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

function storedChannelMessage(overrides: Record<string, unknown> = {}) {
  return {
    body: "hello @bob",
    createdAt: new Date("2026-11-24T00:00:00.000Z"),
    threadRootId: null,
    workspaceId: "ws-1",
    conversation: { channelName: "general", kind: null },
    sender: {
      userId: "user-sender",
      agentId: null,
      user: { displayName: "Sender", username: "sender" },
      agent: null,
    },
    mentions: [
      {
        kind: "user",
        actorId: "user-mentioned",
        handle: "bob",
        member: {
          user: { displayName: "Bob", username: "bob" },
          agent: null,
        },
      },
    ],
    forwards: [],
    systemMessage: null,
    actionCard: null,
    ...overrides,
  };
}

describe("announceMessage hot path", () => {
  test("reads conversation_members once for top-level channel messages and publishes buckets concurrently", async () => {
    let memberFindManyCalls = 0;
    const firstBucketStarted = deferred<void>();
    const firstBucketRelease = deferred<void>();
    let secondBucketStarted = false;
    const publishedBuckets: Array<{
      userIds: readonly string[];
      event: ConversationActivityEvent;
    }> = [];

    const db = {
      $queryRaw: async () => [],
      message: {
        findUnique: async () => storedChannelMessage(),
      },
      conversationMember: {
        findMany: async () => {
          memberFindManyCalls += 1;
          return [
            { id: "m-sender", userId: "user-sender", notificationLevel: "all" },
            { id: "m-normal", userId: "user-normal", notificationLevel: "all" },
            { id: "m-mentioned", userId: "user-mentioned", notificationLevel: "all" },
            { id: "m-muted", userId: "user-muted", notificationLevel: "muted" },
          ];
        },
      },
    } as unknown as PrismaClient;

    const pending = announceMessage(
      db,
      {
        messageAvailable: async () => {},
        conversationActivity: async (bucket) => {
          publishedBuckets.push(bucket);
          if (publishedBuckets.length === 1) {
            firstBucketStarted.resolve();
            await firstBucketRelease.promise;
          } else if (publishedBuckets.length === 2) {
            secondBucketStarted = true;
          }
        },
      },
      {
        conversationId: "conv-1",
        messageId: "msg-1",
        sequence: 10,
        workspaceId: "ws-1",
        senderUserId: "user-sender",
      },
    );

    try {
      await firstBucketStarted.promise;
      expect(secondBucketStarted).toBe(true);
    } finally {
      firstBucketRelease.resolve();
    }
    await pending;

    expect(memberFindManyCalls).toBe(1);
    expect(publishedBuckets).toHaveLength(3);
    expect(publishedBuckets.find((b) => b.event.muted)?.userIds).toEqual(["user-muted"]);
    expect(publishedBuckets.find((b) => b.event.mentioned)?.userIds).toEqual(["user-mentioned"]);
    expect(publishedBuckets.find((b) => !b.event.muted && !b.event.mentioned)?.userIds).toEqual([
      "user-sender",
      "user-normal",
    ]);
  });

  test("keeps muted lookup for direct messages and preserves CentrifugoConversationRealtime this-binding", async () => {
    let memberFindManyCalls = 0;
    const broadcasts: Array<{ channels: string[]; data: ConversationActivityEvent }> = [];

    const db = {
      $queryRaw: async () => [],
      message: {
        findUnique: async () =>
          storedChannelMessage({
            conversation: { channelName: null, kind: null },
            mentions: [],
          }),
      },
      conversationMember: {
        findMany: async () => {
          memberFindManyCalls += 1;
          return [{ userId: "user-1" }];
        },
      },
    } as unknown as PrismaClient;

    const realtime = new CentrifugoConversationRealtime({
      publishJson: async () => {},
      broadcast: async (channels: string[], data: unknown) => {
        broadcasts.push({ channels, data: data as ConversationActivityEvent });
      },
    } as unknown as CentrifugoServerApi);

    await announceMessage(db, realtime, {
      conversationId: "dm-1",
      messageId: "msg-2",
      sequence: 2,
      workspaceId: "ws-1",
      userId: "user-1",
      agentId: "agent-1",
    });

    expect(memberFindManyCalls).toBe(1);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.channels).toEqual(["chat:user:user-1"]);
    expect(broadcasts[0]?.data.muted).toBe(true);
  });

  test("overlaps messageAvailable with db.message.findUnique", async () => {
    const availableStarted = deferred<void>();
    const availableRelease = deferred<void>();
    let messageLookupStarted = false;

    const db = {
      $queryRaw: async () => [],
      message: {
        findUnique: async () => {
          messageLookupStarted = true;
          return null;
        },
      },
    } as unknown as PrismaClient;

    const pending = announceMessage(
      db,
      {
        messageAvailable: async () => {
          availableStarted.resolve();
          await availableRelease.promise;
        },
        conversationActivity: async () => {},
      },
      {
        conversationId: "conv-1",
        messageId: "msg-1",
        sequence: 1,
        workspaceId: "ws-1",
      },
    );

    try {
      await availableStarted.promise;
      expect(messageLookupStarted).toBe(true);
    } finally {
      availableRelease.resolve();
    }
    await pending;
  });
});

describe("taskReferenceViews and taskReferenceView", () => {
  test("skips conversationMember queries when only channel tasks are referenced and batches across agents", async () => {
    let conversationFindManyCalls = 0;
    let memberFindManyCalls = 0;
    const publicId = "11111111-1111-4111-8111-111111111111";
    const privateId = "22222222-2222-4222-8222-222222222222";
    const body = `${channelTaskReferenceToken(publicId, "general", 4)} and ${channelTaskReferenceToken(privateId, "secret", 9)}`;

    const db = {
      conversation: {
        findMany: async () => {
          conversationFindManyCalls += 1;
          return [
            { id: publicId, visibility: "public", members: [] },
            { id: privateId, visibility: "private", members: [{ agentId: "agent-a" }] },
          ];
        },
      },
      conversationMember: {
        findMany: async () => {
          memberFindManyCalls += 1;
          return [];
        },
      },
      user: { findMany: async () => [] },
      agent: { findMany: async () => [] },
    } as unknown as Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">;

    const views = await taskReferenceViews(
      db,
      "ws-1",
      ["agent-a", "agent-b"],
      "conv-current",
      body,
    );

    expect(conversationFindManyCalls).toBe(1);
    expect(memberFindManyCalls).toBe(0);
    expect(readableBody(body, { mention: () => undefined, task: views.get("agent-a") })).toBe(
      "#general:#4 and #secret:#9",
    );
    expect(readableBody(body, { mention: () => undefined, task: views.get("agent-b") })).toBe(
      "#general:#4 and a task you cannot view",
    );
  });

  test("batches DM task views across multiple agents and skips empty peer lookup when unreadable", async () => {
    const dmId = "33333333-3333-4333-8333-333333333333";
    const body = dmTaskReferenceToken(dmId, "beta", 9);

    let memberCalls: Array<Record<string, unknown>> = [];
    const readableDb = {
      conversation: { findMany: async () => [] },
      conversationMember: {
        findMany: async (args: Record<string, unknown>) => {
          memberCalls.push(args);
          if (memberCalls.length === 1) {
            return [
              { conversationId: dmId, agentId: "agent-a" },
              { conversationId: dmId, agentId: "agent-b" },
            ];
          }
          return [
            { conversationId: dmId, userId: null, agentId: "agent-a" },
            { conversationId: dmId, userId: null, agentId: "agent-b" },
          ];
        },
      },
      user: { findMany: async () => [] },
      agent: {
        findMany: async (args: { where: { id?: { in: string[] }; name?: { in: string[] } } }) => {
          if (args.where.id) {
            return [
              { id: "agent-a", name: "alpha" },
              { id: "agent-b", name: "beta" },
            ];
          }
          return [{ name: "alpha" }, { name: "beta" }];
        },
      },
    } as unknown as Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">;

    const views = await taskReferenceViews(
      readableDb,
      "ws-1",
      ["agent-a", "agent-b", "agent-outsider"],
      "conv-channel",
      body,
    );

    expect(memberCalls).toHaveLength(2);
    expect(readableBody(body, { mention: () => undefined, task: views.get("agent-a") })).toBe(
      "dm:@beta:#9",
    );
    expect(readableBody(body, { mention: () => undefined, task: views.get("agent-b") })).toBe(
      "dm:@alpha:#9",
    );
    expect(
      readableBody(body, { mention: () => undefined, task: views.get("agent-outsider") }),
    ).toBe("dm:@beta:#9");

    memberCalls = [];
    const unreadableDb = {
      conversation: { findMany: async () => [] },
      conversationMember: {
        findMany: async (args: Record<string, unknown>) => {
          memberCalls.push(args);
          return [];
        },
      },
      user: { findMany: async () => [] },
      agent: { findMany: async () => [] },
    } as unknown as Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">;

    const single = await taskReferenceView(
      unreadableDb,
      "ws-1",
      "agent-outsider",
      "conv-channel",
      body,
    );
    expect(memberCalls).toHaveLength(1);
    expect(readableBody(body, { mention: () => undefined, task: single })).toBe("dm:@beta:#9");

    const agentDmId = "55555555-5555-4555-8555-555555555555";
    const humanDmId = "66666666-6666-4666-8666-666666666666";
    const ambiguousBody = `${dmTaskReferenceToken(agentDmId, "twin", 1)} ${dmTaskReferenceToken(humanDmId, "twin", 2)}`;
    let ambMemberCalls = 0;
    const ambiguousDb = {
      conversation: { findMany: async () => [] },
      conversationMember: {
        findMany: async () => {
          ambMemberCalls += 1;
          if (ambMemberCalls === 1) {
            return [
              { conversationId: agentDmId, agentId: "reader" },
              { conversationId: humanDmId, agentId: "reader" },
            ];
          }
          return [
            { conversationId: agentDmId, userId: null, agentId: "reader" },
            { conversationId: agentDmId, userId: null, agentId: "twin-agent" },
            { conversationId: humanDmId, userId: null, agentId: "reader" },
            { conversationId: humanDmId, userId: "twin-user", agentId: null },
          ];
        },
      },
      user: {
        findMany: async (args: {
          where: { id?: { in: string[] }; username?: { in: string[] } };
        }) => (args.where.id ? [{ id: "twin-user", username: "twin" }] : [{ username: "twin" }]),
      },
      agent: {
        findMany: async (args: { where: { id?: { in: string[] }; name?: { in: string[] } } }) =>
          args.where.id ? [{ id: "twin-agent", name: "twin" }] : [{ name: "twin" }],
      },
    } as unknown as Pick<PrismaClient, "conversationMember" | "conversation" | "user" | "agent">;

    const ambView = await taskReferenceView(
      ambiguousDb,
      "ws-1",
      "reader",
      "conv-channel",
      ambiguousBody,
    );
    expect(readableBody(ambiguousBody, { mention: () => undefined, task: ambView })).toBe(
      "dm:@twin~agent:#1 dm:@twin~human:#2",
    );
  });
});

describe("sendChannel post-commit concurrency and batched taskReferenceViews", () => {
  test("overlaps post-commit mention reads with publication and batches taskReferenceViews across deliveries", async () => {
    const publicTaskChannelId = "44444444-4444-4444-8444-444444444444";
    const storedBody = `check ${channelTaskReferenceToken(publicTaskChannelId, "ops", 7)}`;
    const announcementStarted = deferred<void>();
    const announcementRelease = deferred<void>();
    let pendingActionsStarted = false;
    let taskRefConversationQueries = 0;

    const db = {
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
        findMany: async () => {
          taskRefConversationQueries += 1;
          return [{ id: publicTaskChannelId, visibility: "public", members: [] }];
        },
      },
      conversationMember: {
        findFirst: async () => ({ id: "member-1", userId: "user-1", leftAt: null }),
        findMany: async () => [],
      },
      message: {
        findFirstOrThrow: async () => ({
          id: "msg-1",
          workspaceId: "ws-1",
          conversationId: "conv-1",
          senderMemberId: "member-1",
          threadRootId: null,
          body: storedBody,
          sequence: 5,
          createdAt: new Date("2026-11-24T00:00:00.000Z"),
          mentions: [],
          attachments: [],
          forwards: [],
          reactions: [],
          reactionVersion: 0,
          systemMessage: null,
          actionCard: null,
          sender: {
            agentId: null,
            agent: null,
            user: {
              id: "user-1",
              username: "frank",
              displayName: "Frank",
              avatarObjectKey: null,
              description: "",
            },
          },
          deliveries: [
            { deliveryId: "d-1", agentId: "agent-1", agent: { computerId: "comp-1" } },
            { deliveryId: "d-2", agentId: "agent-2", agent: { computerId: "comp-1" } },
            { deliveryId: "d-3", agentId: "agent-3", agent: { computerId: "comp-1" } },
          ],
        }),
        findUnique: async () => null,
      },
      pendingMentionAction: {
        findMany: async () => {
          pendingActionsStarted = true;
          return [];
        },
      },
    } as unknown as PrismaClient;

    const pending = sendChannel(
      {
        db,
        idempotency: {
          execute: async () => ({
            id: "msg-1",
            target: "#general",
            attachments: [],
          }),
        } as unknown as Parameters<typeof sendChannel>[0]["idempotency"],
        realtime: {
          messageAvailable: async () => {
            announcementStarted.resolve();
            await announcementRelease.promise;
          },
          conversationActivity: async () => {},
          memberChanged: async () => {},
        },
        publisher: {
          publishBatch: async (publications: readonly unknown[]) =>
            publications.map(() => ({ status: "fulfilled" as const, value: undefined })),
        } as unknown as CentrifugoServerApi,
      },
      {
        workspaceId: "ws-1",
        userId: "user-1",
        channelId: "conv-1",
        idempotencyKey: "req-1",
        body: storedBody,
      },
    );

    try {
      await announcementStarted.promise;
      expect(pendingActionsStarted).toBe(true);
    } finally {
      announcementRelease.resolve();
    }
    const result = await pending;
    expect(taskRefConversationQueries).toBe(1);
    expect(result.unresolvedMentionHandles).toEqual([]);
    expect(result.pendingMentionActions).toEqual([]);
  });
});

describe("AgentDeliveryPublisher.publish", () => {
  test("starts mentions.issue concurrently with feature and notice reads", async () => {
    let issueStartedSynchronously = false;
    const api: Pick<CentrifugoServerApi, "publishBatch"> = {
      publishBatch: async (publications) =>
        publications.map(() => ({ status: "fulfilled" as const, value: undefined })),
    };
    const push: AgentDeliveryPush = {
      computerId: "comp-1",
      requestId: "req-1",
      conversationId: "conv-1",
      agentId: "agent-1",
      messageId: "msg-1",
      deliveryId: "del-1",
      sequence: 1,
      createdAtMs: 1_700_000_000_000,
      target: "#general",
      latestSenderKind: "human",
      latestSenderHandle: "frank",
      latestSenderDescription: "",
      body: "hello",
      mentions: [],
      mentionsAgent: true,
    };

    const pending = new AgentDeliveryPublisher(api, {
      issue: async () => {
        issueStartedSynchronously = true;
        return new Map();
      },
    }).publish("ws-1", [push]);

    expect(issueStartedSynchronously).toBe(true);
    const results = await pending;
    expect(results).toEqual([{ status: "fulfilled", value: undefined }]);
  });
});
