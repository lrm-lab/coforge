import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { UNNAMED_PERSON_NAME } from "#src/lib/human-label";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

describe("PrismaDirectConversationRepository message tasks", () => {
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
              sourceOfTasks:
                read === 3
                  ? []
                  : (() => {
                      const state = taskStates[Math.min(read++, 2)];
                      return state ? [state] : [];
                    })(),
            },
          ];
        },
      },
      conversation: { findUnique: async () => ({ directKey: null, workspaceId: "w" }) },
      messageRead: { findFirst: async () => null, create: async () => ({}) },
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

    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.tasks).toBe(
      undefined,
    );
    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.tasks).toEqual([
      {
        number: 31,
        status: "todo",
      },
    ]);
    expect((await repository.readMessages("workspace-1", "agent-1", "@frank"))[0]?.tasks).toEqual([
      {
        number: 31,
        status: "in_review",
        owner: { displayName: "Ada Lovelace", handle: "ada" },
      },
    ]);
    expect(
      (await repository.readMessages("workspace-1", "agent-1", "@frank:12345678"))[0]?.tasks,
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
            sourceOfTasks: [
              {
                number: 31,
                status: "todo",
                owner: { user: owners[read++], agent: null },
              },
            ],
          },
        ],
      },
      conversation: { findUnique: async () => ({ directKey: null, workspaceId: "w" }) },
      messageRead: { findFirst: async () => null, create: async () => ({}) },
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
      ownerLabels.push(message?.tasks?.[0]?.owner);
    }

    expect(ownerLabels).toEqual([
      { displayName: "Countess", handle: "ada" },
      { displayName: UNNAMED_PERSON_NAME, handle: "grace" },
      { displayName: UNNAMED_PERSON_NAME, handle: "alan" },
    ]);
  });
});
