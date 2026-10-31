import { describe, expect, test } from "bun:test";
import { flattenSqlValues } from "./helpers/prisma-sql";
import {
  RECOVERY_CREATED_AT,
  RECOVERY_CREATED_AT_MS,
  recoverySecondPassStubs,
} from "./helpers/recovery-second-pass-stubs";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  PrismaDirectConversationRepository,
  type AgentRecoveryContext,
} from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository recovery", () => {
  test("builds a stable per-target oldest-first recovery batch with a global limit", async () => {
    const queries: unknown[][] = [];
    const row = (overrides: Partial<Record<string, unknown>>) => ({
      id: "message",
      sequence: 1,
      body: "body",
      conversationId: "conversation-0",
      threadRootId: null,
      senderMemberId: "member-alice",
      createdAt: RECOVERY_CREATED_AT,
      deliveryId: "delivery",
      senderAgentName: null,
      senderAgentDescription: null,
      senderUsername: "alice",
      senderUserDescription: "",
      channelName: null,
      otherUsername: "alice",
      unreadCount: 120,
      globalRank: 1,
      ...overrides,
    });
    const rows = [
      ...Array.from({ length: 100 }, (_, offset) =>
        row({
          id: `conversation-0-message-${offset + 5}`,
          sequence: offset + 5,
          body: `body-${offset + 5}`,
          deliveryId: `conversation-0-delivery-${offset + 5}`,
          globalRank: offset + 1,
        }),
      ),
      // Past the resume budget: contributes its target's count only, so a missing
      // delivery here must not fail recovery.
      row({
        id: "conversation-0-reply-130",
        sequence: 130,
        threadRootId: "root-1",
        deliveryId: null,
        unreadCount: 3,
        globalRank: 121,
      }),
      row({
        id: "conversation-1-message-9",
        sequence: 9,
        conversationId: "conversation-1",
        senderMemberId: "member-bob",
        createdAt: RECOVERY_CREATED_AT,
        senderUsername: "bob",
        otherUsername: "bob",
        unreadCount: 75,
        globalRank: 124,
      }),
    ];
    const db = {
      agent: { findMany: async () => [] },
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(flattenSqlValues(values));
        return rows;
      },
      ...recoverySecondPassStubs,
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(queries).toHaveLength(1);
    // One statement, bound only to the Workspace, the Agent, and the resume budget: the channel
    // top level and the channel thread replies (each its membership, then deliveries not already
    // read as a non-member), the two direct-message branches, the notified-non-member branch (and
    // its not-a-member check), the membership join, the delivery join, the comment-delivery
    // branch, the budget.
    expect(queries[0]).toEqual([
      ...Array.from({ length: 2 }, () => [
        "workspace-1",
        "agent-1",
        // Not already read while the Agent was notified from outside the channel.
        "agent-1",
      ]).flat(),
      ...Array.from({ length: 2 }, () => ["workspace-1", "agent-1"]).flat(),
      // The notified-non-member branch, on public channels only.
      "public",
      "workspace-1",
      "agent-1",
      "agent-1",
      // The attachment-comment delivery branch.
      "workspace-1",
      "agent-1",
      "workspace-1",
      "agent-1",
      "agent-1",
      100,
    ]);
    expect(result.resumeMessages).toHaveLength(100);
    expect(result.resumeMessages.slice(0, 2)).toEqual<AgentRecoveryContext["resumeMessages"]>([
      {
        messageId: "conversation-0-message-5",
        deliveryId: "conversation-0-delivery-5",
        conversationId: "conversation-0",
        sequence: 5,
        target: "@alice",
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
        body: "body-5",
        createdAtMs: RECOVERY_CREATED_AT_MS,
      },
      {
        messageId: "conversation-0-message-6",
        deliveryId: "conversation-0-delivery-6",
        conversationId: "conversation-0",
        sequence: 6,
        target: "@alice",
        latestSenderKind: "human",
        latestSenderHandle: "alice",
        latestSenderDescription: "",
        body: "body-6",
        createdAtMs: RECOVERY_CREATED_AT_MS,
      },
    ]);
    expect(result.unreadSummary).toEqual({ "@alice": 120, "@alice:root-1": 3, "@bob": 75 });
  });

  test("names channel senders individually and direct senders by the conversation user", async () => {
    const db = {
      conversation: { findMany: async () => [] },
      ...recoverySecondPassStubs,
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 7,
          body: "from carol",
          conversationId: "channel-1",
          threadRootId: "root-1",
          senderMemberId: "member-carol",
          createdAt: RECOVERY_CREATED_AT,
          deliveryId: "delivery-1",
          senderAgentName: null,
          senderAgentDescription: null,
          senderUsername: "carol",
          senderUserDescription: "",
          channelName: "general",
          otherUsername: "ada",
          unreadCount: 2,
          globalRank: 1,
        },
        {
          id: "message-2",
          sequence: 8,
          body: "system notice",
          conversationId: "channel-1",
          threadRootId: "root-1",
          senderMemberId: null,
          createdAt: RECOVERY_CREATED_AT,
          deliveryId: "delivery-2",
          senderUsername: null,
          channelName: "general",
          otherUsername: "ada",
          unreadCount: 2,
          globalRank: 2,
        },
      ],
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(
      result.resumeMessages.map((m) => [m.target, m.latestSenderKind, m.latestSenderHandle]),
    ).toEqual([
      ["#general:root-1", "human", "carol"],
      ["#general:root-1", "system", ""],
    ]);
    expect(result.unreadSummary).toEqual({ "#general:root-1": 2 });
  });

  test("reads a direct message's sender from the message and its target from the other member", async () => {
    // The two are different values and must not be confused: the sender is the message's author,
    // while a DM's target is the conversation's *other* member — the one the Agent replies to.
    const db = {
      agent: { findMany: async () => [] },
      ...recoverySecondPassStubs,
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "handoff",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-author",
          createdAt: RECOVERY_CREATED_AT,
          deliveryId: "delivery-1",
          senderAgentName: null,
          senderAgentDescription: null,
          senderUsername: "author-agent",
          senderUserDescription: "",
          channelName: null,
          otherUsername: "recipient-agent",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    const recovery = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );
    expect(recovery.resumeMessages).toEqual<AgentRecoveryContext["resumeMessages"]>([
      {
        messageId: "message-1",
        deliveryId: "delivery-1",
        conversationId: "conversation-1",
        sequence: 1,
        target: "@recipient-agent",
        latestSenderKind: "human",
        latestSenderHandle: "author-agent",
        latestSenderDescription: "",
        body: "handoff",
        createdAtMs: RECOVERY_CREATED_AT_MS,
      },
    ]);
    expect(recovery.unreadSummary).toEqual({ "@recipient-agent": 1 });
  });

  test("fails closed rather than shipping a degraded sender when no name can be resolved", async () => {
    // An author row the database cannot produce (both `users.username`
    // and `agents.name` are NOT NULL) must fail with a named error rather than substitute
    // `"@agent"` or a bare `"@"` — the shape that previously poisoned daemon ready recovery.
    const db = {
      agent: { findMany: async () => [] },
      ...recoverySecondPassStubs,
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "handoff",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-author",
          createdAt: RECOVERY_CREATED_AT,
          deliveryId: "delivery-1",
          senderAgentName: null,
          senderAgentDescription: null,
          senderUsername: null,
          senderUserDescription: null,
          channelName: null,
          otherUsername: "recipient",
          unreadCount: 1,
          globalRank: 1,
        },
      ],
    } as unknown as PrismaClient;

    await expect(
      new PrismaDirectConversationRepository(db).readAgentRecoveryContext("workspace-1", "agent-1"),
    ).rejects.toThrow("Agent message sender could not be resolved");
  });
});
