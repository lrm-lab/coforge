import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/** Only an `unread` read moves the Agent's read position, and it moves it across a sequence the
 * conversation does not have. */

test("an unanchored canonical read advances across a missing sequence", async () => {
  const updates: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ agentReadThroughSequence: 1 }),
      updateMany: async (input: object) => {
        updates.push(input);
        return { count: 1 };
      },
    },
    message: {
      findMany: async () => [
        {
          id: "message-3",
          sequence: 3,
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
          attachments: [],
        },
      ],
    },
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

  await new TestConversationRepository(db).readMessagesPage("workspace-1", "agent-1", "@alice", {
    unread: true,
  });

  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 3 } });
});
