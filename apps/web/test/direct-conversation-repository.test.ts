import { flattenSqlValues } from "./helpers/prisma-sql";
import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { buildUserAgentConversationCreateInput } from "#src/server/db/repositories/user-agent-conversation-input.server";
import {
  PrismaDirectConversationRepository,
  type AgentRecoveryContext,
} from "#src/server/db/repositories/direct-conversation.repositories.server";
import { agentAvatarUrl } from "#src/features/agents/agent-mascot";
import { personAvatarUrl } from "#src/lib/person-picture";

describe("PrismaDirectConversationRepository", () => {
  test("scopes a delivery ACK to the Agent's current Computer assignment", async () => {
    const updates: object[] = [];
    const db = {
      conversationMember: { findMany: async () => [] },
      agentMessageDelivery: {
        updateManyAndReturn: async (input: object) => {
          updates.push(input);
          return [{ mentionOutcome: null, mentionLaunchId: null }];
        },
      },
    } as unknown as PrismaClient;

    await new PrismaDirectConversationRepository(db).receiveDeliveryAck({
      workspaceId: "workspace-1",
      computerId: "computer-1",
      agentId: "agent-1",
      deliveryId: "delivery-1",
      messageId: "message-1",
      sequence: 7,
    });

    expect(updates[0]).toMatchObject({
      where: {
        workspaceId: "workspace-1",
        agentId: "agent-1",
        deliveryId: "delivery-1",
        messageId: "message-1",
        sequence: 7,
        agent: { computerId: "computer-1" },
      },
    });
  });

  test("creates a User-Agent conversation through checked relation inputs", () => {
    expect(buildUserAgentConversationCreateInput("workspace-1", "user-1", "agent-1")).toEqual({
      workspace: { connect: { id: "workspace-1" } },
      directKey: "agent:agent-1|user:user-1",
      members: {
        create: [
          {
            workspace: { connect: { id: "workspace-1" } },
            user: { connect: { id: "user-1" } },
          },
          {
            workspace: { connect: { id: "workspace-1" } },
            agent: { connect: { id: "agent-1" } },
          },
        ],
      },
    });
  });

  test("resolves the ids a browser send needs without reading messages", async () => {
    const calls: string[] = [];
    const db = {
      conversationMember: {
        findUniqueOrThrow: async (input: object) => {
          calls.push(`member ${JSON.stringify(input)}`);
          return { id: "user-member" };
        },
      },
      message: {
        findMany: async () => {
          calls.push("messages");
          return [];
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        calls.push("conversation");
        return { id: "conversation-1" };
      }
    }

    const ids = await new TestConversationRepository(db).memberForUser(
      "workspace-1",
      "user-1",
      "agent-1",
    );

    expect(ids).toEqual({ conversationId: "conversation-1", senderMemberId: "user-member" });
    expect(calls).toEqual([
      "conversation",
      'member {"where":{"conversationId_userId":{"conversationId":"conversation-1","userId":"user-1"}},"select":{"id":true}}',
    ]);
  });

  test("pages browser history by thread roots, each thread as a summary and never its replies", async () => {
    const queries: object[] = [];
    const message = (id: string, sequence: number) => ({
      id,
      sequence,
      threadRootId: null,
      body: id,
      createdAt: new Date(sequence),
      attachments: [],
      mentions: [],
      sender: { userId: "user-1", user: { username: "alice" }, agent: null },
    });
    const db = {
      threadRead: { findMany: async () => [] },
      $queryRaw: async () => [],
      conversation: {
        findUnique: async () => ({
          members: [
            {
              id: "user-member",
              userId: "user-1",
              agentId: null,
              user: { id: "user-1", username: "alice" },
              agent: null,
            },
            {
              id: "agent-member",
              userId: null,
              agentId: "agent-1",
              user: null,
              agent: { id: "agent-1", name: "helper", displayName: "Helper" },
            },
          ],
        }),
      },
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return [message("root-5", 5), message("root-3", 3), message("root-1", 1)];
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    const page = await new TestConversationRepository(db).openForUser(
      "workspace-1",
      "user-1",
      "agent-1",
      { beforeSequence: 6, limit: 2 },
    );

    expect(queries[0]).toMatchObject({
      where: { conversationId: "conversation-1", threadRootId: null, sequence: { lt: 6 } },
      orderBy: { sequence: "desc" },
      take: 3,
    });
    expect(page.hasOlder).toBe(true);
    // A backward page read with a `beforeSequence` cursor always has newer content above it, which
    // is what tells the bounded window that its newest retained page is no longer the live tail.
    expect(page.hasNewer).toBe(true);
    expect(page.messages.map(({ id, sequence }) => [id, sequence])).toEqual([
      ["root-3", 3],
      ["root-5", 5],
    ]);
    // The page's messages are read without their replies.
    expect(JSON.stringify(queries[0])).not.toContain("replies");
  });

  test("pages towards the live end from a retained page, and reports the tail it reaches", async () => {
    const queries: object[] = [];
    const message = (id: string, sequence: number) => ({
      id,
      sequence,
      threadRootId: null,
      body: id,
      createdAt: new Date(sequence),
      attachments: [],
      mentions: [],
      sender: { userId: "user-1", user: { username: "alice" }, agent: null },
    });
    const rowsFor = (messages: object[]) =>
      ({
        threadRead: { findMany: async () => [] },
        $queryRaw: async () => [],
        conversation: {
          findUnique: async () => {
            return {
              members: [
                {
                  id: "user-member",
                  userId: "user-1",
                  agentId: null,
                  user: {
                    id: "user-1",
                    username: "alice",
                    displayName: "Alice",
                    description: "",
                    avatarObjectKey: null,
                  },
                  agent: null,
                },
                {
                  id: "agent-member",
                  userId: null,
                  agentId: "agent-1",
                  user: null,
                  agent: {
                    id: "agent-1",
                    name: "helper",
                    displayName: "Helper",
                    description: "",
                    avatarMascot: null,
                  },
                },
              ],
            };
          },
        },
        message: {
          findMany: async (input: object) => {
            queries.push(input);
            return messages;
          },
        },
      }) as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    // One row more than the limit: the fetch did not reach the tail.
    const midWindow = await new TestConversationRepository(
      rowsFor([message("root-5", 5), message("root-7", 7)]),
    ).openForUser("workspace-1", "user-1", "agent-1", { afterSequence: 4, limit: 1 });
    expect(queries[0]).toMatchObject({
      where: { conversationId: "conversation-1", threadRootId: null, sequence: { gt: 4 } },
      orderBy: { sequence: "asc" },
      take: 2,
    });
    expect(midWindow.hasOlder).toBe(true);
    expect(midWindow.hasNewer).toBe(true);
    // The page is the first `limit` top-level rows, oldest first; the overflow row is dropped.
    expect(midWindow.messages.map(({ id, sequence }) => [id, sequence])).toEqual([["root-5", 5]]);
    // The viewer's own row is in the list — that is what makes a mention *of the viewer*
    // resolvable, and what the pane's formatter and the composer both read.
    expect(midWindow.viewerId).toBe("user-1");
    expect(midWindow.mentionables).toEqual([
      {
        kind: "user",
        id: "user-1",
        handle: "alice",
        label: "Alice",
        description: "",
        avatarUrl: personAvatarUrl("user-1", null),
        mentionScore: 0,
      },
      {
        kind: "agent",
        id: "agent-1",
        handle: "helper",
        label: "Helper",
        description: "",
        avatarUrl: agentAvatarUrl("agent-1"),
        mentionScore: 0,
      },
    ]);

    // No overflow: this page is the live tail.
    const atTail = await new TestConversationRepository(
      rowsFor([message("root-9", 9)]),
    ).openForUser("workspace-1", "user-1", "agent-1", { afterSequence: 6, limit: 20 });
    expect(atTail.hasOlder).toBe(true);
    expect(atTail.hasNewer).toBe(false);
    expect(atTail.messages.map((message) => message.sequence)).toEqual([9]);
  });

  test("the initial page is the live tail with nothing newer to fetch", async () => {
    const db = {
      conversation: {
        findUnique: async () => ({
          members: [
            {
              id: "user-member",
              userId: "user-1",
              agentId: null,
              user: { id: "user-1", username: "alice" },
              agent: null,
            },
            {
              id: "agent-member",
              userId: null,
              agentId: "agent-1",
              user: null,
              agent: { id: "agent-1", name: "helper", displayName: "Helper" },
            },
          ],
        }),
      },
      message: { findMany: async () => [] },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }

    const page = await new TestConversationRepository(db).openForUser(
      "workspace-1",
      "user-1",
      "agent-1",
    );
    expect(page.hasOlder).toBe(false);
    expect(page.hasNewer).toBe(false);
  });

  test("polls only messages after the browser cursor, including replies to older roots", async () => {
    const queries: object[] = [];
    const db = {
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return [
            {
              id: "reply-12",
              sequence: 12,
              threadRootId: "old-root",
              body: "new reply",
              createdAt: new Date(12),
              attachments: [],
              mentions: [],
              sender: {
                userId: null,
                agentId: "agent-helper",
                user: null,
                agent: { name: "helper", displayName: "Helper", avatarMascot: null },
              },
            },
          ];
        },
      },
    } as unknown as PrismaClient;
    const updates = await new PrismaDirectConversationRepository(db).updatesSince(
      "workspace-1",
      "conversation-1",
      11,
    );

    expect(queries[0]).toMatchObject({
      where: { conversationId: "conversation-1", sequence: { gt: 11 } },
      orderBy: { sequence: "asc" },
      take: 100,
    });
    expect(updates).toMatchObject([
      {
        id: "reply-12",
        sequence: 12,
        threadRootId: "old-root",
        senderKind: "agent",
        senderAgentId: "agent-helper",
      },
    ]);
  });

  test("advances across the Agent's own message when reading the next canonical range", async () => {
    const updates: object[] = [];
    const queries: object[] = [];
    const rows = [2, 3].map((sequence) => ({
      id: `message-${sequence}`,
      sequence,
      body: `body-${sequence}`,
      createdAt: new Date(0),
      sender:
        sequence === 2
          ? { agentId: "agent-1", agent: { name: "helper", description: "" }, user: null }
          : { agentId: null, agent: null, user: { username: "alice", description: "" } },
      attachments: [],
    }));
    const db = {
      agent: { findFirst: async () => null },
      user: { findUnique: async () => ({ id: "user-1" }) },
      conversation: { findUnique: async () => ({ id: "conversation-1" }) },
      conversationMember: {
        findUnique: async () => ({ agentReadThroughSequence: 1 }),
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
      },
      message: {
        findMany: async (input: object) => {
          queries.push(input);
          return rows;
        },
      },
    } as unknown as PrismaClient;
    class TestConversationRepository extends PrismaDirectConversationRepository {
      override async userIdForUsername() {
        return "user-1";
      }
      override async getOrCreateUserAgent() {
        return { id: "conversation-1" };
      }
    }
    const repository = new TestConversationRepository(db);

    const result = await repository.readMessagesPage("workspace-1", "agent-1", "@alice", {
      throughSequence: 3,
    });
    await repository.readMessagesPage("workspace-1", "agent-1", "@alice", {
      fromSequence: 3,
      throughSequence: 3,
    });

    expect(
      result.messages.map(({ sequence, senderKind, senderHandle }) => [
        sequence,
        senderKind,
        senderHandle,
      ]),
    ).toEqual([
      [2, "agent", "helper"],
      [3, "human", "alice"],
    ]);
    expect(queries[0]).toMatchObject({
      where: { conversationId: "conversation-1", sequence: { gte: 2, lte: 3 } },
    });
    expect(updates).toEqual([
      {
        where: {
          conversationId: "conversation-1",
          agentId: "agent-1",
          agentReadThroughSequence: { lt: 3 },
        },
        data: { agentReadThroughSequence: 3 },
      },
    ]);
  });

  test("projects current Task metadata only on its root Message", async () => {
    const taskStates = [
      null,
      {
        number: 31,
        status: "todo",
        owner: null,
      },
      {
        number: 31,
        status: "in_review",
        owner: {
          user: { username: "ada", displayName: "Ada Lovelace" },
          agent: null,
        },
      },
    ];
    let read = 0;
    const db = {
      agent: { findFirst: async () => null },
      user: { findUnique: async () => ({ id: "user-1" }) },
      $executeRaw: async () => 1,
      conversationMember: {
        findUnique: async () => ({ id: "agent-member", agentReadThroughSequence: 0 }),
        updateMany: async () => ({ count: 1 }),
      },
      threadRead: { findUnique: async () => null },
      message: {
        findMany: async (input: { where: { id?: unknown } }) => {
          if (input.where.id)
            return [
              {
                id: "12345678-1234-4234-8234-123456789abc",
                sequence: 1,
                threadRootId: null,
              },
            ];
          return [
            {
              id: read === 3 ? "reply-2" : "root-1",
              sequence: read === 3 ? 2 : 1,
              body: "Ship the release",
              createdAt: new Date(0),
              sender: { agentId: null, agent: null, user: { username: "frank", description: "" } },
              attachments: [],
              task: read === 3 ? null : taskStates[Math.min(read++, 2)],
            },
          ];
        },
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
    const repository = new TestConversationRepository(db);

    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.task).toBe(
      undefined,
    );
    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.task).toEqual({
      number: 31,
      status: "todo",
    });
    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.task).toEqual({
      number: 31,
      status: "in_review",
      owner: { displayName: "Ada Lovelace", handle: "ada" },
    });
    expect(
      (await repository.readMessages("workspace-1", "agent-1", "@frank:12345678"))[0]?.task,
    ).toBe(undefined);
  });

  test("a Task's person owner is named by the label teammates see: display name, never username", async () => {
    const owners = [
      { username: "ada", displayName: "Countess" },
      { username: "grace", displayName: "  " },
      { username: "alan", displayName: null },
    ];
    let read = 0;
    const db = {
      agent: { findFirst: async () => null },
      user: { findUnique: async () => ({ id: "user-1" }) },
      $executeRaw: async () => 1,
      conversationMember: {
        findUnique: async () => ({ id: "agent-member", agentReadThroughSequence: 0 }),
        updateMany: async () => ({ count: 1 }),
      },
      threadRead: { findUnique: async () => null },
      message: {
        findMany: async () => [
          {
            id: "root-1",
            sequence: 1,
            body: "Ship the release",
            createdAt: new Date(0),
            sender: { agentId: null, agent: null, user: { username: "frank", description: "" } },
            attachments: [],
            task: {
              number: 31,
              status: "todo",
              owner: { user: owners[read++], agent: null },
            },
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
    }
    const repository = new TestConversationRepository(db);

    const ownerLabels = [];
    for (const _ of owners) {
      const [message] = await repository.readMessages("workspace-1", "agent-1", "@frank");
      ownerLabels.push(message?.task?.owner);
    }

    expect(ownerLabels).toEqual([
      { displayName: "Countess", handle: "ada" },
      { displayName: UNNAMED_PERSON_NAME, handle: "grace" },
      { displayName: UNNAMED_PERSON_NAME, handle: "alan" },
    ]);
  });

  test("an unanchored canonical read advances across a missing sequence", async () => {
    const updates: object[] = [];
    const db = {
      agent: { findFirst: async () => null },
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

    await new TestConversationRepository(db).readMessagesPage("workspace-1", "agent-1", "@alice");

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ data: { agentReadThroughSequence: 3 } });
  });

  test("bounds and monotonically advances only the authorized Agent conversation", async () => {
    const updates: object[] = [];
    const db = {
      agent: { findFirst: async () => null },
      user: { findUnique: async () => ({ id: "user-1" }) },
      message: { findFirst: async () => ({ sequence: 9 }) },
      conversationMember: {
        updateMany: async (input: object) => {
          updates.push(input);
          return { count: 1 };
        },
      },
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
  });

  test("returns zero without advancing when the authorized conversation has no messages", async () => {
    let updates = 0;
    const db = {
      agent: { findFirst: async () => null },
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

  test("builds a stable per-target oldest-first recovery batch with a global limit", async () => {
    const queries: unknown[][] = [];
    const row = (overrides: Partial<Record<string, unknown>>) => ({
      id: "message",
      sequence: 1,
      body: "body",
      conversationId: "conversation-0",
      threadRootId: null,
      senderMemberId: "member-alice",
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
      messageMention: { findMany: async () => [] },
      memoryHintRecord: { findMany: async () => [] },
    } as unknown as PrismaClient;

    const result = await new PrismaDirectConversationRepository(db).readAgentRecoveryContext(
      "workspace-1",
      "agent-1",
    );

    expect(queries).toHaveLength(1);
    // One statement, bound only to the Workspace, the Agent, and the resume budget: the channel
    // top level and the channel thread replies (each its membership, then deliveries not already
    // read as a non-member), the two direct-message branches, the notified-non-member branch (and
    // its not-a-member check), the membership join, the delivery join, the budget.
    expect(queries[0]).toEqual([
      ...Array.from({ length: 2 }, () => [
        "workspace-1",
        "agent-1",
        // Not already read while the Agent was notified from outside the channel.
        "agent-1",
      ]).flat(),
      ...Array.from({ length: 3 }, () => ["workspace-1", "agent-1"]).flat(),
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
      },
    ]);
    expect(result.unreadSummary).toEqual({ "@alice": 120, "@alice:root-1": 3, "@bob": 75 });
  });

  test("names channel senders individually and direct senders by the conversation user", async () => {
    const db = {
      conversation: { findMany: async () => [] },
      messageMention: { findMany: async () => [] },
      memoryHintRecord: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 7,
          body: "from carol",
          conversationId: "channel-1",
          threadRootId: "root-1",
          senderMemberId: "member-carol",
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
      messageMention: { findMany: async () => [] },
      memoryHintRecord: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "handoff",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-author",
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
      messageMention: { findMany: async () => [] },
      memoryHintRecord: { findMany: async () => [] },
      $queryRaw: async () => [
        {
          id: "message-1",
          sequence: 1,
          body: "handoff",
          conversationId: "conversation-1",
          threadRootId: null,
          senderMemberId: "member-author",
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
