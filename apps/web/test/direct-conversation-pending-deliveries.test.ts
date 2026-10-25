import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaDirectConversationRepository,
  type PendingAgentDelivery,
} from "#src/server/db/repositories/direct-conversation.repositories.server";

/** The repository's reads of an Agent's unacknowledged deliveries (split from
 * `direct-conversation-repository.test.ts` to keep that file within its size limit). */
describe("PrismaDirectConversationRepository pending deliveries", () => {
  test("reads all scoped unacknowledged deliveries oldest-first", async () => {
    const queries: object[] = [];
    const db = {
      agent: { findMany: async () => [] },
      conversationMember: { findMany: async () => [] },
      $queryRaw: async () => [],
      agentMessageDelivery: {
        findMany: async (input: object) => {
          queries.push(input);
          return [
            {
              deliveryId: "delivery-1",
              messageId: "message-1",
              conversationId: "conversation-1",
              sequence: 4,
              conversation: { channelName: null, members: [{ user: { username: "alice" } }] },
              message: {
                createdAt: new Date(1_700_000_000_123),
                body: "pending body",
                sender: {
                  agentId: null,
                  agent: null,
                  user: { username: "alice", description: "" },
                },
                mentions: [],
                pendingMentionActions: [],
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
      "workspace-1",
      "agent-1",
    );

    expect(queries[0]).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        receivedAt: null,
      },
      orderBy: [{ createdAt: "asc" }, { deliveryId: "asc" }],
    });
    expect(queries[0]).not.toHaveProperty("take");
    expect(result).toEqual<PendingAgentDelivery[]>([
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 4,
        target: "@alice",
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
        body: "pending body",
        createdAtMs: 1_700_000_000_123,
      },
    ]);
  });

  test("reads Agent-authored pending deliveries with the Agent handle", async () => {
    const db = {
      conversation: { findMany: async () => [] },
      conversationMember: { findMany: async () => [] },
      $queryRaw: async () => [],
      agentMessageDelivery: {
        findMany: async () => [
          {
            deliveryId: "delivery-agent",
            messageId: "message-agent",
            conversationId: "conversation-1",
            sequence: 5,
            conversation: { channelName: "general", members: [] },
            message: {
              createdAt: new Date(1_700_000_005_000),
              body: "@reviewer please review",
              sender: {
                agentId: "sender-agent",
                agent: { name: "helper", description: "" },
                user: null,
              },
              mentions: [],
              pendingMentionActions: [],
            },
          },
        ],
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
        "workspace-1",
        "agent-1",
      ),
    ).resolves.toEqual<PendingAgentDelivery[]>([
      {
        messageId: "message-agent",
        deliveryId: "delivery-agent",
        conversationId: "conversation-1",
        sequence: 5,
        target: "#general",
        latestSenderKind: "agent",
        latestSenderHandle: "helper",
        latestSenderDescription: "",
        body: "@reviewer please review",
        createdAtMs: 1_700_000_005_000,
      },
    ]);
  });

  test("rejects a pending delivery without a valid public username target", async () => {
    const db = {
      agent: { findMany: async () => [] },
      conversationMember: { findMany: async () => [] },
      $queryRaw: async () => [],
      agentMessageDelivery: {
        findMany: async () => [
          {
            deliveryId: "delivery-1",
            messageId: "message-1",
            conversationId: "conversation-1",
            sequence: 1,
            conversation: { channelName: null, members: [{ user: { username: "Invalid Name" } }] },
            message: {
              body: "body",
              sender: { user: { username: "Invalid Name" } },
            },
          },
        ],
      },
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readPendingAgentDeliveries(
        "workspace-1",
        "agent-1",
      ),
    ).rejects.toThrow("public @username");
  });
});
