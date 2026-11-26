import { describe, expect, mock, test } from "bun:test";

import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { sendChannel } from "#src/server/conversations/channel-send.server";
import { channelMentionTargets } from "#src/server/conversations/message-references.server";
import { UserDirectConversations } from "#src/server/conversations/user-direct-conversations.server";

describe("channelMentionTargets sequential transaction safety", () => {
  test("runs user, agent, and member queries sequentially on tx", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    async function track<T>(value: T): Promise<T> {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await Promise.resolve();
      try {
        return value;
      } finally {
        inFlight -= 1;
      }
    }
    const tx = {
      user: { findMany: () => track([{ id: "u-bob", username: "bob" }]) },
      agent: { findMany: () => track([]) },
      conversationMember: {
        findMany: () => track([{ id: "m-bob", userId: "u-bob", agentId: null }]),
      },
    } as unknown as Prisma.TransactionClient;

    const targets = await channelMentionTargets(
      tx,
      { workspaceId: "ws-1", conversationId: "conv-1" },
      ["bob"],
    );
    expect(maxConcurrent).toBe(1);
    expect(targets).toEqual([{ key: "m-bob", type: "user", id: "u-bob", handle: "bob" }]);
  });
});

describe("sendChannel error precedence and attachment deduplication", () => {
  test("preserves access > body > threadRoot error precedence", async () => {
    const baseDb = {
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
        findFirst: async () => ({ id: "member-1", userId: "user-1", leftAt: null }),
      },
      message: {
        findFirst: async () => {
          throw new Error("P2023 invalid uuid");
        },
      },
    } as unknown as PrismaClient;

    await expect(
      sendChannel(
        { db: baseDb },
        {
          workspaceId: "ws-1",
          userId: "user-1",
          channelId: "conv-1",
          idempotencyKey: "req-err-1",
          body: "   ",
          threadRootId: "not-a-uuid",
        },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const deniedDb = {
      ...baseDb,
      conversationMember: {
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;

    await expect(
      sendChannel(
        { db: deniedDb },
        {
          workspaceId: "ws-1",
          userId: "user-1",
          channelId: "conv-1",
          idempotencyKey: "req-err-2",
          body: "hello",
          threadRootId: "not-a-uuid",
        },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  test("deduplicates duplicate attachmentIds in sendChannel fast path", async () => {
    const executeRaw = mock(
      async (_sql: TemplateStringsArray, _messageId: string, ids: string[], _positions: number[]) =>
        ids.length,
    );
    const createdAt = new Date("2026-11-25T10:00:00.000Z");
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: async () => [{ next: 15 }],
      conversation: { findFirst: async () => null },
      conversationMember: { findMany: async () => [] },
      attachment: {
        findMany: async () => [
          {
            id: "att-1",
            fileName: "a.txt",
            contentType: "text/plain",
            sizeBytes: 10,
            imageWidth: null,
            imageHeight: null,
            objectKey: "k1",
            forwardPosition: null,
          },
          {
            id: "att-2",
            fileName: "b.txt",
            contentType: "text/plain",
            sizeBytes: 20,
            imageWidth: null,
            imageHeight: null,
            objectKey: "k2",
            forwardPosition: null,
          },
        ],
      },
      message: {
        create: async () => ({
          id: "msg-15",
          workspaceId: "ws-1",
          conversationId: "conv-1",
          senderMemberId: "member-1",
          threadRootId: null,
          body: "with dupes",
          sequence: 15,
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
            description: "",
          },
        }),
        findMany: async () => [],
      },
    } as unknown as PrismaClient;

    const sent = await sendChannel(
      {
        db,
        idempotency: { execute: async (_scope, persist) => persist() },
        realtime: {
          messageAvailable: async () => {},
          conversationActivity: async () => {},
          memberChanged: async () => {},
        },
      },
      {
        workspaceId: "ws-1",
        userId: "user-1",
        channelId: "conv-1",
        idempotencyKey: "req-dup-att",
        body: "with dupes",
        attachmentIds: ["att-1", "att-2", "att-1"],
      },
    );

    expect(executeRaw.mock.calls).toEqual([
      [expect.any(Array), "msg-15", ["att-1", "att-2"], [0, 1]],
    ]);
    expect(sent.attachments.map((att) => att.id)).toEqual(["att-1", "att-2"]);
  });
});

describe("UserDirectConversations replay snapshot guard", () => {
  test("falls back to db.message.findUnique on idempotency replay instead of using cached payload", async () => {
    let findUniqueCalls = 0;
    const db = {
      $queryRaw: async () => [],
      conversation: {
        findFirst: async () => ({
          directKey: "user:ada|user:grace",
          members: [
            { id: "m-ada", userId: "ada", user: { displayName: "Ada", username: "ada" } },
            { id: "m-grace", userId: "grace", user: { displayName: "Grace", username: "grace" } },
          ],
        }),
      },
      conversationMember: { findMany: async () => [] },
      message: {
        findUnique: async () => {
          findUniqueCalls += 1;
          return {
            body: "edited body",
            createdAt: new Date("2026-11-25T10:00:00.000Z"),
            threadRootId: null,
            workspaceId: "ws-1",
            conversation: { channelName: null, kind: null },
            sender: {
              userId: "ada",
              agentId: null,
              user: { displayName: "Ada", username: "ada" },
              agent: null,
            },
            mentions: [],
            forwards: [],
            systemMessage: null,
            actionCard: null,
          };
        },
      },
    } as unknown as PrismaClient;

    const dm = new UserDirectConversations(
      db,
      {
        execute: async () => ({
          id: "msg-replay",
          body: "stale cached body",
          createdAt: new Date("2026-11-25T10:00:00.000Z"),
          sequence: 3,
          threadRootId: null,
          workspaceId: "ws-1",
          attachments: [],
        }),
      },
      {
        messageAvailable: async () => {},
        conversationActivity: async () => {},
      },
    );

    await dm.send({
      workspaceId: "ws-1",
      conversationId: "conv-dm",
      senderUserId: "ada",
      body: "stale cached body",
      idempotencyKey: "req-replay",
    });

    expect(findUniqueCalls).toBe(1);
  });
});
