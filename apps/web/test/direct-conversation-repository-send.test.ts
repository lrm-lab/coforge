import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository sending", () => {
  test("sendAgentMessage links two attachments in send order and rejects one the Agent did not upload", async () => {
    const updates: { where: unknown; data: unknown }[] = [];
    let attachmentQueries = 0;
    const attachmentsById: Record<
      string,
      {
        id: string;
        fileName: string;
        contentType: string;
        sizeBytes: number;
        uploaderAgentId: string;
      }
    > = {
      "attach-b": {
        id: "attach-b",
        fileName: "b.txt",
        contentType: "text/plain",
        sizeBytes: 2,
        uploaderAgentId: "agent-1",
      },
      "attach-a": {
        id: "attach-a",
        fileName: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        uploaderAgentId: "agent-1",
      },
      "attach-foreign": {
        id: "attach-foreign",
        fileName: "f.txt",
        contentType: "text/plain",
        sizeBytes: 3,
        uploaderAgentId: "agent-2",
      },
    };
    const tx = {
      $queryRaw: async () => [],
      message: {
        findFirst: async () => null,
        create: async ({ data }: { data: { body: string } }) => ({
          id: "message-new",
          body: data.body,
          createdAt: new Date("2026-09-17T00:00:00Z"),
          sequence: 1,
          deliveries: [],
        }),
      },
      attachment: {
        findMany: async ({
          where,
        }: {
          where: { id: { in: string[] }; uploaderAgentId: string; messageId: null };
        }) => {
          attachmentQueries += 1;
          return where.id.in.flatMap((id) => {
            const row = attachmentsById[id];
            if (!row || row.uploaderAgentId !== where.uploaderAgentId) return [];
            return [
              {
                id: row.id,
                fileName: row.fileName,
                contentType: row.contentType,
                sizeBytes: row.sizeBytes,
              },
            ];
          });
        },
        update: async ({ where, data }: { where: unknown; data: unknown }) => {
          updates.push({ where, data });
          return {};
        },
      },
      conversationMember: { findMany: async () => [] },
      threadFollow: { createMany: async () => {} },
    };
    const db = {
      agent: {
        findUnique: async () => ({ ownerId: "user-1", visibility: "public" }),
      },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            agent: { name: "agent-1", description: "" },
          },
          { id: "member-user", agentId: null, userId: "user-1" },
        ],
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaDirectConversationRepository(db);

    const result = await repository.sendAgentMessage("conversation-1", "agent-1", "two files", [
      "attach-b",
      "attach-a",
    ]);

    // Order matches send order (B, then A), not any other reordering.
    expect(result.attachments.map((a) => a.id)).toEqual(["attach-b", "attach-a"]);
    expect(attachmentQueries).toBe(1);
    expect(updates).toEqual([
      { where: { id: "attach-b" }, data: { messageId: "message-new", position: 0 } },
      { where: { id: "attach-a" }, data: { messageId: "message-new", position: 1 } },
    ]);

    // The uploaderAgentId gap: a different Agent's unlinked attachment is rejected, which
    // closes that gap.
    await expect(
      repository.sendAgentMessage("conversation-1", "agent-1", "not mine", ["attach-foreign"]),
    ).rejects.toThrow("attachment is not available for this message");
  });

  test("sendAgentMessage stores a resolvable task reference as a token and leaves an unknown number alone", async () => {
    const created: { data: { body: string } }[] = [];
    const tx = {
      $queryRaw: async () => [],
      message: {
        findFirst: async () => null,
        create: async ({ data }: { data: { body: string } }) => {
          created.push({ data });
          return {
            id: "message-new",
            body: data.body,
            createdAt: new Date("2026-09-17T00:00:00Z"),
            sequence: 1,
            deliveries: [],
          };
        },
      },
      attachment: { findMany: async () => [], update: async () => ({}) },
      task: {
        findMany: async ({ where }: { where: { number: { in: number[] } } }) =>
          where.number.in.filter((number) => number === 68).map((number) => ({ number })),
      },
      conversationMember: { findMany: async () => [] },
      threadFollow: { createMany: async () => {} },
    };
    const db = {
      agent: { findUnique: async () => ({ ownerId: "user-1", visibility: "public" }) },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            agent: { name: "agent-1", description: "" },
          },
          { id: "member-user", agentId: null, userId: "user-1" },
        ],
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;

    await new PrismaDirectConversationRepository(db).sendAgentMessage(
      "conversation-1",
      "agent-1",
      "follow task #68, not task #999",
      [],
    );

    // Only the number that names a real task of this conversation becomes a structured reference.
    expect(created[0]!.data.body).toBe("follow <@task:68>, not task #999");
  });

  test("sendMessage links two human-uploaded attachments in send order", async () => {
    const updates: { where: unknown; data: unknown }[] = [];
    let attachmentQueries = 0;
    const attachmentsById: Record<
      string,
      { id: string; fileName: string; contentType: string; sizeBytes: number; objectKey: string }
    > = {
      "attach-b": {
        id: "attach-b",
        fileName: "b.txt",
        contentType: "text/plain",
        sizeBytes: 2,
        objectKey: "key-b",
      },
      "attach-a": {
        id: "attach-a",
        fileName: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        objectKey: "key-a",
      },
    };
    const tx = {
      $queryRaw: async () => [],
      message: {
        findFirst: async () => null,
        create: async ({ data }: { data: { body: string } }) => ({
          id: "message-new",
          body: data.body,
          createdAt: new Date("2026-09-17T00:00:00Z"),
          sequence: 1,
          deliveries: [{ deliveryId: "delivery-1" }],
        }),
      },
      attachment: {
        findMany: async ({ where }: { where: { id: { in: string[] }; uploaderId: string } }) => {
          attachmentQueries += 1;
          return where.id.in.flatMap((id) => {
            const row = attachmentsById[id];
            if (!row || where.uploaderId !== "user-1") return [];
            return [row];
          });
        },
        update: async ({ where, data }: { where: unknown; data: unknown }) => {
          updates.push({ where, data });
          return {};
        },
      },
    };
    const db = {
      conversation: {
        findUnique: async () => ({
          workspaceId: "workspace-1",
          members: [
            { id: "member-user", userId: "user-1", agentId: null, user: { username: "alice" } },
            {
              id: "member-agent",
              userId: null,
              agentId: "agent-1",
              agent: { name: "helper", computerId: null, ownerId: "user-1", visibility: "public" },
            },
          ],
        }),
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;
    const repository = new PrismaDirectConversationRepository(db);

    const result = await repository.sendMessage(
      "conversation-1",
      "member-user",
      "user-1",
      "two files",
      ["attach-b", "attach-a"],
    );

    expect(result.attachments.map((a) => a.id)).toEqual(["attach-b", "attach-a"]);
    expect(attachmentQueries).toBe(1);
    expect(updates).toEqual([
      { where: { id: "attach-b" }, data: { messageId: "message-new", position: 0 } },
      { where: { id: "attach-a" }, data: { messageId: "message-new", position: 1 } },
    ]);
  });

  test("sendMessage rejects a non-creator sending into a since-privatized DM", async () => {
    const db = {
      conversation: {
        findUnique: async () => ({
          workspaceId: "workspace-1",
          members: [
            { id: "member-user", userId: "user-2", agentId: null, user: { username: "bob" } },
            {
              id: "member-agent",
              userId: null,
              agentId: "agent-1",
              agent: {
                name: "helper",
                computerId: null,
                ownerId: "user-1",
                visibility: "private",
              },
            },
          ],
        }),
      },
    } as unknown as PrismaClient;
    await expect(
      new PrismaDirectConversationRepository(db).sendMessage(
        "conversation-1",
        "member-user",
        "user-2",
        "hello",
      ),
    ).rejects.toMatchObject({ name: "AppError", code: "AGENT_DM_RESTRICTED" });
  });

  test("sendAgentMessage rejects a private Agent's own outbound DM to a non-creator", async () => {
    const db = {
      agent: {
        findUnique: async () => ({ ownerId: "user-1", visibility: "private" }),
      },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            agent: { name: "agent-1", description: "" },
          },
          { id: "member-user", agentId: null, userId: "user-2" },
        ],
      },
      $transaction: async (fn: (tx: unknown) => unknown) => fn({}),
    } as unknown as PrismaClient;
    await expect(
      new PrismaDirectConversationRepository(db).sendAgentMessage(
        "conversation-1",
        "agent-1",
        "hello",
      ),
    ).rejects.toMatchObject({ name: "AgentSendRejectedError", status: 403 });
  });

  test("sendAgentMessage rejoins a soft-left Agent on a DM before sending", async () => {
    const memberUpdates: { where: unknown; data: unknown }[] = [];
    const tx = {
      $queryRaw: async () => [],
      message: {
        findFirst: async () => null,
        create: async ({ data }: { data: { body: string } }) => ({
          id: "message-rejoined",
          body: data.body,
          createdAt: new Date("2026-09-23T10:00:00Z"),
          sequence: 9,
          threadRootId: null,
          mentions: [],
          deliveries: [],
        }),
      },
      attachment: { findMany: async () => [] },
      conversationMember: { findMany: async () => [] },
      threadFollow: { createMany: async () => {} },
      task: { findMany: async () => [] },
    };
    const db = {
      agent: {
        findUnique: async () => ({
          ownerId: "user-1",
          visibility: "public",
          deletedAt: null,
        }),
      },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            leftAt: new Date("2026-09-18T09:32:30Z"),
            agent: { name: "agent-1", description: "" },
          },
          { id: "member-user", agentId: null, userId: "user-1", leftAt: null },
        ],
        update: async ({ where, data }: { where: unknown; data: unknown }) => {
          memberUpdates.push({ where, data });
          return {};
        },
      },
      $transaction: async (fn: (client: unknown) => unknown) => fn(tx),
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).sendAgentMessage(
      "conversation-1",
      "agent-1",
      "hello after rejoin",
    );

    expect(memberUpdates).toEqual([{ where: { id: "member-agent" }, data: { leftAt: null } }]);
    expect(result).toMatchObject({ id: "message-rejoined", sequence: 9 });
  });

  test("sendAgentMessage rejects a soft-left Agent on a channel without rejoining", async () => {
    const memberUpdates: unknown[] = [];
    const db = {
      conversation: {
        findUnique: async () => ({
          id: "channel-1",
          workspaceId: "workspace-1",
          channelName: "team",
          archivedAt: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            leftAt: new Date("2026-09-18T09:32:30Z"),
            agent: { name: "agent-1", description: "" },
          },
        ],
        update: async (input: unknown) => {
          memberUpdates.push(input);
          return {};
        },
      },
      $transaction: async () => {
        throw new Error("transaction must not run");
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).sendAgentMessage("channel-1", "agent-1", "hello"),
    ).rejects.toMatchObject({ name: "AgentSendRejectedError", status: 403 });
    expect(memberUpdates).toEqual([]);
  });

  test("sendAgentMessage does not rejoin a soft-left DM when the Agent is deleted", async () => {
    const memberUpdates: unknown[] = [];
    const db = {
      agent: {
        findUnique: async () => ({ deletedAt: new Date("2026-09-18T09:32:30Z") }),
      },
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          channelName: null,
        }),
      },
      conversationMember: {
        findMany: async () => [
          {
            id: "member-agent",
            agentId: "agent-1",
            userId: null,
            leftAt: new Date("2026-09-18T09:32:30Z"),
            agent: { name: "agent-1", description: "" },
          },
          { id: "member-user", agentId: null, userId: "user-1", leftAt: null },
        ],
        update: async (input: unknown) => {
          memberUpdates.push(input);
          return {};
        },
      },
      $transaction: async () => {
        throw new Error("transaction must not run");
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).sendAgentMessage(
        "conversation-1",
        "agent-1",
        "hello",
      ),
    ).rejects.toMatchObject({ name: "AgentSendRejectedError", status: 403 });
    expect(memberUpdates).toEqual([]);
  });
});
