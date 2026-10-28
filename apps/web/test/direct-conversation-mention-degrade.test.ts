import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository sending", () => {
  test("sendAgentMessage degrades a --mention binding to a removed member to a pending action", async () => {
    const created: { data: Record<string, unknown> }[] = [];
    const pendingRows: { data: unknown[] }[] = [];
    const tx = {
      $queryRaw: async () => [{ first: 1 }],
      message: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push({ data });
          return {
            id: "message-new",
            body: data.body,
            createdAt: new Date("2026-09-17T00:00:00Z"),
            sequence: 1,
            mentions: [],
            deliveries: [],
          };
        },
      },
      attachment: { findMany: async () => [], update: async () => ({}) },
      task: { findMany: async () => [] },
      conversation: { findMany: async () => [], findFirst: async () => null },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            agent: { name: "a1", description: "", deletedAt: null },
          },
        ],
        findFirst: async () => null,
      },
      threadFollow: { createMany: async () => {} },
      workspaceMembership: {
        findMany: async ({ where }: { where: { userId?: { in: string[] } } }) =>
          where.userId?.in?.includes("user-gone") ? [{ userId: "user-gone" }] : [],
      },
      agent: { findMany: async () => [] },
      user: { findMany: async () => [{ id: "user-gone", username: "carol" }] },
      pendingMentionAction: {
        createMany: async ({ data }: { data: unknown[] }) => {
          pendingRows.push({ data });
        },
      },
    };
    const db = {
      agent: { findUnique: async () => ({ ownerId: "user-1", visibility: "public" }) },
      conversation: {
        findUnique: async () => ({
          id: "channel-1",
          workspaceId: "workspace-1",
          channelName: "chan",
          archivedAt: null,
          directKey: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            leftAt: null,
            agent: { name: "a1" },
          },
          {
            id: "member-carol",
            agentId: null,
            userId: "user-gone",
            leftAt: new Date("2026-09-16T00:00:00Z"),
            user: { username: "carol" },
          },
        ],
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).sendAgentMessage(
      "channel-1",
      "agent-1",
      "hello",
      [],
      undefined,
      [{ type: "user", id: "user-gone", name: "carol" }],
    );

    // The removed member's mention leaves no token or mention row, but the sender keeps a
    // pending action for them — the same outcome as an @handle the lock could not resolve.
    expect(created[0]!.data.mentions).toBeUndefined();
    expect(pendingRows).toEqual([
      {
        data: [
          expect.objectContaining({
            targetUserId: "user-gone",
            targetHandle: "carol",
            messageId: "message-new",
          }),
        ],
      },
    ]);
    expect(result.id).toBe("message-new");
  });

  test("sendAgentMessage drops a --mention binding to an id outside the Workspace", async () => {
    const pendingRows: { data: unknown[] }[] = [];
    const tx = {
      $queryRaw: async () => [{ first: 1 }],
      message: {
        findMany: async () => [],
        create: async ({ data }: { data: Record<string, unknown> }) => ({
          id: "message-new",
          body: data.body,
          createdAt: new Date("2026-09-17T00:00:00Z"),
          sequence: 1,
          mentions: [],
          deliveries: [],
        }),
      },
      attachment: { findMany: async () => [], update: async () => ({}) },
      task: { findMany: async () => [] },
      conversation: { findMany: async () => [], findFirst: async () => null },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            agent: { name: "a1", description: "", deletedAt: null },
          },
        ],
        findFirst: async () => null,
      },
      threadFollow: { createMany: async () => {} },
      workspaceMembership: { findMany: async () => [] },
      agent: { findMany: async () => [] },
      user: { findMany: async () => [] },
      pendingMentionAction: {
        createMany: async ({ data }: { data: unknown[] }) => {
          pendingRows.push({ data });
        },
      },
    };
    const db = {
      agent: { findUnique: async () => ({ ownerId: "user-1", visibility: "public" }) },
      conversation: {
        findUnique: async () => ({
          id: "channel-1",
          workspaceId: "workspace-1",
          channelName: "chan",
          archivedAt: null,
          directKey: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            leftAt: null,
            agent: { name: "a1" },
          },
          // The binding names an agent id present in the roster, so it passes the member check,
          // but that agent belongs to another Workspace — the row must not be written.
          {
            id: "member-foreign",
            agentId: "agent-foreign",
            userId: null,
            leftAt: new Date("2026-09-16T00:00:00Z"),
            agent: { name: "foreign" },
          },
        ],
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).sendAgentMessage(
      "channel-1",
      "agent-1",
      "hello",
      [],
      undefined,
      [{ type: "agent", id: "agent-foreign", name: "foreign" }],
    );

    // `agent-foreign` is not an agent of this Workspace: no pending action row for it, but the
    // send itself still succeeds.
    expect(pendingRows).toEqual([]);
    expect(result.id).toBe("message-new");
  });
});
