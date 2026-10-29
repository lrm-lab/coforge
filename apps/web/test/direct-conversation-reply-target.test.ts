import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { AppError } from "#src/lib/app-error";
import { PrismaDirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

const ROOT_ID = "0194f1c2-aaaa-7bbb-8ccc-ddddeeeeffff";

/** The reads `resolveAgentReplyTarget` makes, over one Workspace: the channel `#general` the Agent
 * is in, `@frank` (a member) with a direct message, `@gone` (left the Workspace) with one, and
 * `@new` (a member) with none. Any write fails the test. */
function fakeDb(options: { assistant?: boolean } = {}) {
  const writes: string[] = [];
  const users: Record<string, string> = { frank: "user-frank", gone: "user-gone", new: "user-new" };
  const directs: Record<string, string> = {
    [agentDirectKey("user-frank", "agent-1")]: "dm-frank",
    [agentDirectKey("user-gone", "agent-1")]: "dm-gone",
  };
  const db = {
    agent: {
      findMany: async () => [],
      findFirst: async () => ({
        systemKind: options.assistant ? WORKSPACE_ASSISTANT_KIND : null,
        workspaceAssistantSession: options.assistant
          ? { userId: "user-owner", user: { username: "owner", memberships: [{ role: "owner" }] } }
          : null,
      }),
    },
    conversation: {
      // The Agent's own membership comes with the channel (`getAgentSendChannel`).
      findFirst: async ({ where }: { where: { channelName: string } }) =>
        where.channelName === "general"
          ? {
              id: "channel-general",
              channelName: "general",
              archivedAt: null,
              members: [{ id: "member-agent-1", leftAt: null }],
            }
          : null,
      findUnique: async ({
        where,
      }: {
        where: { workspaceId_directKey: { directKey: string } };
      }) => {
        const id = directs[where.workspaceId_directKey.directKey];
        return id ? { id } : null;
      },
      create: async () => writes.push("conversation.create"),
    },
    user: {
      findUnique: async ({ where }: { where: { username: string } }) =>
        users[where.username] ? { id: users[where.username] } : null,
    },
    workspaceMembership: {
      findUnique: async ({ where }: { where: { workspaceId_userId: { userId: string } } }) =>
        where.workspaceId_userId.userId === "user-gone" ? null : { userId: "user-frank" },
    },
    message: {
      findMany: async ({
        where,
      }: {
        where: { conversationId: string; id: { gte: string; lte: string } };
      }) =>
        (where.conversationId === "channel-general" || where.conversationId === "dm-frank") &&
        where.id.gte <= ROOT_ID &&
        ROOT_ID <= where.id.lte
          ? [{ id: ROOT_ID, sequence: 1, threadRootId: null, senderMemberId: "m" }]
          : [],
    },
  } as unknown as PrismaClient;
  return { writes, repository: new PrismaDirectConversationRepository(db) };
}

const resolve = (target: string, options?: { assistant?: boolean }) => {
  const { repository, writes } = fakeDb(options);
  return {
    writes,
    result: repository.resolveAgentReplyTarget("workspace-1", "agent-1", target),
  };
};

describe("PrismaDirectConversationRepository.resolveAgentReplyTarget", () => {
  test("a channel the Agent is in resolves to its conversation, at the top level or in a thread", async () => {
    expect(await resolve("#general").result).toMatchObject({
      conversationId: "channel-general",
      threadRootId: null,
      isChannel: true,
      peerUserId: undefined,
    });
    expect(await resolve("#general:0194f1c2").result).toMatchObject({
      conversationId: "channel-general",
      threadRootId: ROOT_ID,
    });
  });

  test("an @user the Agent already has a direct message with resolves to it, naming the person", async () => {
    expect(await resolve("@frank").result).toMatchObject({
      conversationId: "dm-frank",
      threadRootId: null,
      isChannel: false,
      peerUserId: "user-frank",
    });
    expect(await resolve("@frank:0194f1c2").result).toMatchObject({
      conversationId: "dm-frank",
      threadRootId: ROOT_ID,
      peerUserId: "user-frank",
    });
  });

  test("a direct message is looked up, never started", async () => {
    const { result, writes } = resolve("@new");
    await expect(result).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  test("a direct message with someone who left the Workspace is not resolved", async () => {
    await expect(resolve("@gone").result).rejects.toMatchObject({
      code: "DM_PEER_NOT_IN_WORKSPACE",
    });
  });

  test("a target the Agent cannot post to is not resolved", async () => {
    await expect(resolve("#secret").result).rejects.toThrow();
    await expect(resolve("@nobody").result).rejects.toThrow();
    await expect(resolve("#general:ffffffff").result).rejects.toThrow();
    // An app's event conversation is read-only for an Agent.
    await expect(resolve("@app.billing").result).rejects.toBeInstanceOf(AppError);
  });

  test("a Workspace assistant's direct message is not resolved: its lookup opens one", async () => {
    const { result, writes } = resolve("@frank", { assistant: true });
    await expect(result).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(writes).toEqual([]);
  });
});
