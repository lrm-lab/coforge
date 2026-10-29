import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/** An Agent's read cursor in a direct message: how far `coforge message read` moves it. */
describe("PrismaDirectConversationRepository Agent read cursor", () => {
  test("bounds and monotonically advances only the authorized Agent conversation", async () => {
    const updates: object[] = [];
    const reads: { data: object }[] = [];
    const db = {
      agent: { findMany: async () => [] },
      user: { findUnique: async () => ({ id: "user-1" }) },
      message: { findFirst: async () => ({ sequence: 9 }) },
      conversationMember: {
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
        findFirstOrThrow: async () => ({ id: "member-agent-1" }),
      },
      // A direct conversation: the move is recorded with its time, in the same transaction.
      conversation: {
        findUnique: async () => ({ directKey: "direct-key", workspaceId: "workspace-1" }),
      },
      messageRead: {
        findFirst: async () => null,
        create: async (input: { data: object }) => reads.push(input),
      },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername(target: string) {
        expect(target).toBe("@alice");
        return "user-1";
      }
      // Reading resolves an existing DM first; the person is still a member here.
      override async findUserAgentConversation(
        workspaceId: string,
        userId: string,
        agentId: string,
      ) {
        expect([workspaceId, userId, agentId]).toEqual(["workspace-1", "user-1", "agent-1"]);
        return { id: "conversation-1" };
      }
      override async getOrCreateUserAgent(workspaceId: string, userId: string, agentId: string) {
        expect([workspaceId, userId, agentId]).toEqual(["workspace-1", "user-1", "agent-1"]);
        return { id: "conversation-1" };
      }
    }

    const bounded = await new TestConversationRepository(db).advanceAgentReadThrough(
      "workspace-1",
      "agent-1",
      "@alice",
      999,
    );

    expect(bounded).toBe(9);
    expect(updates).toEqual([
      {
        where: {
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          agentReadThroughSequence: { lt: 9 },
        },
        data: { agentReadThroughSequence: 9 },
      },
    ]);
    expect(reads).toMatchObject([
      { data: { conversationId: "conversation-1", memberId: "member-agent-1", sequence: 9 } },
    ]);
  });

  test("returns zero without advancing when the authorized conversation has no messages", async () => {
    let updates = 0;
    const db = {
      agent: { findMany: async () => [] },
      user: { findUnique: async () => ({ id: "user-1" }) },
      message: { findFirst: async () => null },
      conversationMember: { updateMany: async () => void updates++ },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername() {
        return "user-1";
      }
      override async findUserAgentConversation() {
        return { id: "conversation-1" };
      }
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    expect(
      await new TestConversationRepository(db).advanceAgentReadThrough(
        "workspace-1",
        "agent-1",
        "@alice",
        999,
      ),
    ).toBe(0);
    expect(updates).toBe(0);
  });
});
