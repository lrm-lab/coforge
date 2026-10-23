import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

// Who may start a direct message with an Agent, and who may write in one that exists.
describe("getOrCreateUserAgent", () => {
  function fixture(options: { visibility: string; ownerId: string; existing?: { id: string } }) {
    const created: unknown[] = [];
    const db = {
      agent: {
        findFirst: async () => ({
          id: "agent-1",
          ownerId: options.ownerId,
          visibility: options.visibility,
        }),
      },
      conversation: {
        findUnique: async () => options.existing ?? null,
        create: async (input: { data: unknown }) => {
          created.push(input.data);
          return { id: "conversation-new" };
        },
      },
    } as unknown as PrismaClient;
    return { repository: new PrismaDirectConversationRepository(db), created };
  }

  test("a non-creator cannot start a brand-new DM with a private Agent", async () => {
    const { repository, created } = fixture({ visibility: "private", ownerId: "user-1" });
    await expect(
      repository.getOrCreateUserAgent("workspace-1", "user-2", "agent-1"),
    ).rejects.toMatchObject({ name: "AppError", code: "AGENT_DM_RESTRICTED" });
    expect(created).toEqual([]);
  });

  test("the creator can always start a DM with their own private Agent", async () => {
    const { repository, created } = fixture({ visibility: "private", ownerId: "user-1" });
    await repository.getOrCreateUserAgent("workspace-1", "user-1", "agent-1");
    expect(created).toHaveLength(1);
  });

  test("anyone can start a DM with a public Agent", async () => {
    const { repository, created } = fixture({ visibility: "public", ownerId: "user-1" });
    await repository.getOrCreateUserAgent("workspace-1", "user-2", "agent-1");
    expect(created).toHaveLength(1);
  });

  test("an existing DM with a since-privatized Agent stays open for reading, not creation", async () => {
    const { repository, created } = fixture({
      visibility: "private",
      ownerId: "user-1",
      existing: { id: "conversation-old" },
    });
    const conversation = await repository.getOrCreateUserAgent("workspace-1", "user-2", "agent-1");
    expect(conversation).toEqual({ id: "conversation-old" });
    expect(created).toEqual([]);
  });
});

describe("openForUser reports dmWritable", () => {
  function fixture(options: { visibility: string; ownerId: string; viewerId: string }) {
    const db = {
      conversation: {
        findUnique: async () => ({
          id: "conversation-1",
          workspaceId: "workspace-1",
          directKey: `agent:agent-1|user:${options.viewerId}`,
          members: [
            {
              id: "member-user",
              userId: options.viewerId,
              agentId: null,
              readThroughSequence: 0,
              user: { id: options.viewerId, username: "viewer" },
            },
            {
              id: "member-agent",
              userId: null,
              agentId: "agent-1",
              readThroughSequence: 0,
              agent: {
                id: "agent-1",
                name: "helper",
                displayName: "Helper",
                deletedAt: null,
                ownerId: options.ownerId,
                visibility: options.visibility,
              },
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
    return new TestConversationRepository(db);
  }

  test("the creator can always send, public or private", async () => {
    const repository = fixture({ visibility: "private", ownerId: "user-1", viewerId: "user-1" });
    const page = await repository.openForUser("workspace-1", "user-1", "agent-1");
    expect(page.dmWritable).toBe(true);
  });

  test("a non-creator's existing DM with a private Agent reads read-only", async () => {
    const repository = fixture({ visibility: "private", ownerId: "user-1", viewerId: "user-2" });
    const page = await repository.openForUser("workspace-1", "user-2", "agent-1");
    expect(page.dmWritable).toBe(false);
  });

  test("a public Agent's DM is always writable", async () => {
    const repository = fixture({ visibility: "public", ownerId: "user-1", viewerId: "user-2" });
    const page = await repository.openForUser("workspace-1", "user-2", "agent-1");
    expect(page.dmWritable).toBe(true);
  });
});
