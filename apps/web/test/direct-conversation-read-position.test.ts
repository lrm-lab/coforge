import { expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
import { advanceAgentReadPosition } from "#src/server/db/repositories/agent-read-position.repositories.server";
import { publishConversationReadChangesAfterCommit } from "#src/server/db/repositories/agent-read-groups.repositories.server";
import { readAgentMessagePage } from "#src/server/db/repositories/agent-message-history.repositories.server";

/** What `advanceAgentRead` reads beside the cursor: a direct conversation records a time. */
const readAdvanceStores = {
  messageRead: { findFirst: async () => null, create: async () => ({}) },
  conversation: { findUnique: async () => ({ directKey: "user:a|user:b", workspaceId: "w" }) },
};
/** The same for a channel: no direct key, so nothing is recorded. */
const channelReadStores = {
  ...readAdvanceStores,
  conversation: { findMany: async () => [], findUnique: async () => ({ directKey: null, workspaceId: "w" }) },
};

/** Unread reads and complete latest pages move the Agent's read position monotonically. */

test("an unanchored canonical read advances across a missing sequence", async () => {
  const events: object[] = [];
  const updates: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
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
    ...readAdvanceStores,
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

  await new TestConversationRepository(
    db,
    {},
    {
      conversationReadChanged: async (event: object) => {
        events.push(event);
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@alice", { unread: true });

  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 3 } });
  expect(events).toEqual([
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      memberId: "member-1",
      readThroughSequence: 3,
    },
  ]);
});

test("a plain latest read advances a User-Agent DM when the full unread page fits", async () => {
  const updates: object[] = [];
  const events: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
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
          body: "newest",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        },
        {
          id: "message-2",
          sequence: 2,
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
    ...readAdvanceStores,
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
  const page = await new TestConversationRepository(
    db,
    {},
    {
      conversationReadChanged: async (event: object) => {
        events.push(event);
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@alice", {});
  expect(page.modelSeenUpToSeq).toBe(3);
  expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 3 } });
  expect(events).toEqual([
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      memberId: "member-1",
      readThroughSequence: 3,
    },
  ]);
});

test("a plain latest read leaves the cursor when unread messages exceed the page", async () => {
  const updates: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 0 }),
      updateMany: async (input: object) => {
        updates.push(input);
        return { count: 1 };
      },
    },
    message: {
      findMany: async () =>
        [1, 2, 3].map((sequence) => ({
          id: `message-${sequence}`,
          sequence,
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        })),
    },
    ...readAdvanceStores,
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
  const page = await new TestConversationRepository(
    db,
    {},
    {
      conversationReadChanged: async () => {
        throw new Error("must not publish");
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@alice", { limit: 2 });
  expect(page.modelSeenUpToSeq).toBeNull();
  expect(updates).toEqual([]);
});

test("a plain latest read advances when only the tail of a full page is unread", async () => {
  const updates: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 2 }),
      updateMany: async (input: object) => {
        updates.push(input);
        return { count: 1 };
      },
    },
    message: {
      findMany: async () =>
        [4, 3, 2].map((sequence) => ({
          id: `message-${sequence}`,
          sequence,
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        })),
    },
    ...readAdvanceStores,
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
  const page = await new TestConversationRepository(db).readMessagesPage(
    "workspace-1",
    "agent-1",
    "@alice",
    {
      limit: 2,
    },
  );
  expect(page.modelSeenUpToSeq).toBe(4);
  expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 4 } });
});

test("a plain latest read advances across a sequence gap when the omitted row is already read", async () => {
  const updates: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 3 }),
      updateMany: async (input: object) => {
        updates.push(input);
        return { count: 1 };
      },
    },
    message: {
      findMany: async () =>
        [6, 5, 3].map((sequence) => ({
          id: `message-${sequence}`,
          sequence,
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "alice", description: "" } },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        })),
    },
    ...readAdvanceStores,
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
  const page = await new TestConversationRepository(db).readMessagesPage(
    "workspace-1",
    "agent-1",
    "@alice",
    {
      limit: 2,
    },
  );
  expect(page.modelSeenUpToSeq).toBe(6);
  expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 6 } });
});

test("a plain historical read never advances the User-Agent DM cursor", async () => {
  const updates: object[] = [];
  let anchorLookup = true;
  const db = {
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
      updateMany: async (input: object) => {
        updates.push(input);
        return { count: 1 };
      },
    },
    message: {
      findMany: async () =>
        anchorLookup
          ? ((anchorLookup = false),
            [{ id: "deadbeef", sequence: 3, threadRootId: null, senderMemberId: null }])
          : [
              {
                id: "message-1",
                sequence: 1,
                body: "old",
                createdAt: new Date(0),
                sender: {
                  agentId: null,
                  agent: null,
                  user: { username: "alice", description: "" },
                },
                attachments: [],
                mentions: [],
                memoryHint: null,
                task: null,
                actionCard: null,
              },
            ],
    },
    ...readAdvanceStores,
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
  }
  const page = await new TestConversationRepository(
    db,
    {},
    {
      conversationReadChanged: async () => {
        throw new Error("must not publish");
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@alice", { before: "deadbeef" });
  expect(page.modelSeenUpToSeq).toBe(1);
  expect(updates).toEqual([]);
});

test("an Agent peer read does not publish a User-Agent DM event", async () => {
  const events: object[] = [];
  const db = {
    agent: {
      findMany: async () => [
        {
          id: "peer-1",
          name: "peer",
          ownerId: "owner-1",
          visibility: "public",
          systemKind: null,
        },
      ],
      findFirst: async () => ({ ownerId: "owner-1", role: "member", systemKind: null }),
    },
    user: { findUnique: async () => null },
    conversation: { findMany: async () => [], findUnique: async () => ({ id: "conversation-1" }) },
    workspaceMembership: { findUnique: async () => null },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
    message: {
      findMany: async () => [
        {
          id: "message-3",
          sequence: 3,
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: "peer-1", agent: { name: "peer", description: "" }, user: null },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        },
      ],
    },
    messageRead: { findFirst: async () => null, create: async () => ({}) },
  } as unknown as PrismaClient;
  await new PrismaDirectConversationRepository(
    db,
    {},
    {
      conversationReadChanged: async (event: object) => {
        events.push(event);
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@peer~agent", { unread: true });
  expect(events).toEqual([]);
});

test("an app event session read does not publish a User-Agent DM event", async () => {
  const events: object[] = [];
  const db = {
    appAgentEvent: { findFirst: async () => ({ conversationId: "app-conversation-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
    message: {
      findMany: async () => [
        {
          id: "message-3",
          sequence: 3,
          body: "pending",
          createdAt: new Date(0),
          sender: { agentId: null, agent: null, user: { username: "app", description: "" } },
          attachments: [],
          mentions: [],
          memoryHint: null,
          task: null,
          actionCard: null,
        },
      ],
    },
    ...readAdvanceStores,
  } as unknown as PrismaClient;
  await new PrismaDirectConversationRepository(
    db,
    {},
    {
      conversationReadChanged: async (event: object) => {
        events.push(event);
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@app.demo", { unread: true });
  expect(events).toEqual([]);
});

test("publishes a conversation read position only after the database advances", async () => {
  const events: object[] = [];
  const db = {
    agent: { findMany: async () => [] },
    user: { findUnique: async () => ({ id: "user-1" }) },
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
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
    ...readAdvanceStores,
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
      conversationReadChanged: async (event: object) => {
        events.push(event);
      },
    },
  ).readMessagesPage("workspace-1", "agent-1", "@alice", { unread: true });
  expect(events).toEqual([
    {
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      memberId: "member-1",
      readThroughSequence: 3,
    },
  ]);
});

test("thread reads stay silent while channel reads publish the shared event", async () => {
  const db = {
    conversationMember: { updateMany: async () => ({ count: 1 }) },
    $executeRaw: async () => 1,
    ...readAdvanceStores,
  } as unknown as PrismaClient;
  expect(
    await advanceAgentReadPosition({
      db,
      memberId: "member-1",
      conversationId: "channel-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      sequence: 4,
      publishConversationRead: true,
    }),
  ).toMatchObject({ memberId: "member-1" });
  expect(
    await advanceAgentReadPosition({
      db,
      memberId: "member-1",
      conversationId: "channel-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      threadRootId: "root-1",
      sequence: 5,
      publishConversationRead: false,
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
      publishConversationRead: false,
    }),
  ).toBeUndefined();
});

test("a rolled-back drain does not publish collected Agent read changes", async () => {
  const published: object[] = [];
  await expect(
    publishConversationReadChangesAfterCommit(
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

test("channel main reads publish while DM thread reads stay silent", async () => {
  const events: object[] = [];
  const db = {
    conversationMember: {
      findUnique: async () => ({ id: "member-1", agentReadThroughSequence: 1 }),
      updateMany: async () => ({ count: 1 }),
    },
    threadRead: { findUnique: async () => ({ readThroughSequence: 1 }) },
    ...channelReadStores,
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
    messageRead: { findFirst: async () => null, create: async () => ({}) },
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
    conversationReadChanged: async (event) => {
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
    conversationReadChanged: async (event) => {
      events.push(event);
    },
    resolveAnchor: async () => ({ id: "root-1", sequence: 1, threadRootId: "root-1" }),
  });
  expect(events).toEqual([
    {
      workspaceId: "workspace-1",
      conversationId: "channel-1",
      memberId: "member-1",
      readThroughSequence: 3,
    },
  ]);
});
