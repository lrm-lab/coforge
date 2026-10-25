import { describe, expect, test } from "bun:test";
import { RECOVERY_CREATED_AT, recoverySecondPassStubs } from "./helpers/recovery-second-pass-stubs";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository recovery refusals", () => {
  test("rejects recovery when an unread message has no Agent delivery", async () => {
    const db = {
      agent: { findMany: async () => [] },
      ...recoverySecondPassStubs,
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "body",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-alice",
          createdAt: RECOVERY_CREATED_AT,
          deliveryId: null,
          senderUsername: "alice",
          channelName: null,
          otherUsername: "alice",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("has no delivery");
  });

  test("rejects recovery for a direct conversation with no other member to target", async () => {
    const db = {
      ...recoverySecondPassStubs,
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "body",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: null,
          createdAt: RECOVERY_CREATED_AT,
          deliveryId: "delivery-1",
          senderUsername: null,
          channelName: null,
          otherUsername: null,
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("no other member to target");
  });
});
