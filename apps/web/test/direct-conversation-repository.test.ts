import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { buildUserAgentConversationCreateInput } from "#src/server/db/repositories/user-agent-conversation-input.server";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";
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
      agent: { findMany: async () => [] },
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
      agent: { findMany: async () => [] },
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
      agent: { findMany: async () => [] },
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

  test("bounds and monotonically advances only the authorized Agent conversation", async () => {
    const updates: object[] = [];
    const db = {
      agent: { findMany: async () => [] },
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
