import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { advanceAgentReadPosition } from "#src/server/db/repositories/agent-read-position.repositories.server";
import { publishAgentReadChangesAfterCommit } from "#src/server/db/repositories/agent-read-groups.repositories.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";

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

test("publishes an Agent read position only after the database advances", async () => {
  const events: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ agentReadThroughSequence: 1 }),
      updateMany: async () => ({ count: 1 }),
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
    override async resolveAgentTarget() {
      return {
        conversationId: "conversation-1",
        threadRootId: null,
        canonicalTarget: "@alice",
        isChannel: false,
        isUserAgentDirectConversation: true,
      };
    }
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
  await new TestConversationRepository(
    db,
    {},
    {
      agentReadChanged: async (event: object) => {
        events.push(event);
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@alice", { unread: true });
  expect(events).toEqual([
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      agentId: "agent-1",
      readThroughSequence: 3,
    },
  ]);
});

test("thread and channel read advances do not publish Agent DM events", async () => {
  const db = {
    conversationMember: { updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
  } as unknown as PrismaClient;
  expect(
    await advanceAgentReadPosition({
      db,
      conversationId: "channel-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      sequence: 4,
      isDirectConversation: false,
    }),
  ).toBeUndefined();
  expect(
    await advanceAgentReadPosition({
      db,
      memberId: "member-1",
      conversationId: "channel-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      threadRootId: "root-1",
      sequence: 5,
      isDirectConversation: false,
    }),
  ).toBeUndefined();
  expect(
    await advanceAgentReadPosition({
      db,
      memberId: "member-1",
      conversationId: "conversation-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      threadRootId: "root-1",
      sequence: 6,
      isDirectConversation: true,
    }),
  ).toBeUndefined();
});

test("a rolled-back drain does not publish collected Agent read changes", async () => {
  const published: object[] = [];
  await expect(
    publishAgentReadChangesAfterCommit(
      async () => {
        throw new Error("rollback");
      },
      async (change) => {
        published.push(change);
      },
    ),
  ).rejects.toThrow("rollback");
  expect(published).toEqual([]);
});

test("history reads of a channel or DM thread do not publish a DM main read", async () => {
  const events: object[] = [];
  const db = {
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
    threadRead: { findUnique: async () => ({ readThroughSequence: 1 }) },
    conversation: { findMany: async () => [] },
    message: {
      findMany: async () => [
        {
          id: "message-3",
          sequence: 3,
          threadRootId: "root-1",
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        },
      ],
    },
    $executeRaw: async () => 1,
  } as unknown as PrismaClient;
  const page = {
    unread: true,
    limit: 50,
  };
  await readAgentMessagePage(db, {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    conversationId: "channel-1",
    threadRootId: null,
    canonicalTarget: "#general",
    isChannel: true,
    isUserAgentDirectConversation: false,
    page,
    agentReadChanged: async (event) => {
      events.push(event);
    },
    resolveAnchor: async () => ({ id: "root-1", sequence: 1, threadRootId: "root-1" }),
  });
  await readAgentMessagePage(db, {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    conversationId: "conversation-1",
    threadRootId: "root-1",
    canonicalTarget: "@alice:root-1",
    isChannel: false,
    isUserAgentDirectConversation: true,
    page,
    agentReadChanged: async (event) => {
      events.push(event);
    },
    resolveAnchor: async () => ({ id: "root-1", sequence: 1, threadRootId: "root-1" }),
  });
  expect(events).toEqual([]);
});
