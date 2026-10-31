import type { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { AppError } from "#src/lib/app-error";
import { canDirectMessageAgent } from "#src/server/agents/agent-visibility.server";
import { restoreDirectConversationMembers } from "#src/server/conversations/direct-conversation-members.server";
import { isUniqueViolation } from "#src/server/db/unique-violation.server";
import { buildUserAgentConversationCreateInput } from "./user-agent-conversation-input.server";

/**
 * The direct conversation between a person and an Agent (`agent:<id>|user:<id>`). The one between
 * two Agents is `agent-peer-direct.repositories.server`.
 */

export async function getOrCreateUserAgentConversation(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  agentId: string,
) {
  // Retain deleted-Agent DM history. DirectConversations.authorize checks read/write access;
  // DirectConversations.open refuses to create a deleted Agent's DM.
  const agent = await db.agent.findFirst({
    where: { id: agentId, workspaceId, workspace: { members: { some: { userId } } } },
    select: { id: true, ownerId: true, visibility: true },
  });
  if (!agent) {
    const member = await db.workspaceMembership.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!member) {
      // Someone this Agent already has a DM with, who left: say so. Anyone else outside the
      // Workspace reads exactly like a username that does not exist, so an Agent cannot probe
      // who is registered elsewhere.
      if (await findUserAgentConversation(db, workspaceId, userId, agentId))
        throw new AppError("DM_PEER_NOT_IN_WORKSPACE");
      throw new AppError("TARGET_NOT_ACCESSIBLE");
    }
    throw new AppError("TARGET_NOT_ACCESSIBLE");
  }
  const where = {
    workspaceId_directKey: { workspaceId, directKey: agentDirectKey(userId, agentId) },
  };
  const existing = await db.conversation.findUnique({ where, select: { id: true } });
  if (existing) return existing;
  // A brand-new DM with a private Agent may only ever be started by its own creator:
  // an existing DM someone else already had stays readable/read-only (handled above by
  // returning it unconditionally), but nobody else may open a first one.
  if (!canDirectMessageAgent(userId, agent)) throw new AppError("AGENT_DM_RESTRICTED");
  try {
    return await db.conversation.create({
      data: buildUserAgentConversationCreateInput(workspaceId, userId, agentId),
      select: { id: true },
    });
  } catch (error) {
    // A concurrent first open won the insert; reuse its conversation.
    if (isUniqueViolation(error))
      return db.conversation.findUniqueOrThrow({ where, select: { id: true } });
    throw error;
  }
}

/** The person's DM with an Agent as they open it: `getOrCreateUserAgentConversation`, with their
 * member row restored if it is missing, and whether this open started it (`created`, for
 * `dm.created.v1`; two first opens at once may both say so, which costs a list re-read, not a
 * wrong list). */
export async function openUserAgentConversation(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  agentId: string,
) {
  const created = !(await findUserAgentConversation(db, workspaceId, userId, agentId));
  const conversation = {
    ...(await getOrCreateUserAgentConversation(db, workspaceId, userId, agentId)),
    created,
  };
  await restoreDirectConversationMembers(db, {
    conversationId: conversation.id,
    workspaceId,
    userIds: [userId],
  });
  return conversation;
}

/** Read-only counterpart to `getOrCreateUserAgentConversation`: looks the DM up, never creates it.
 * Used by `channel members @user`, which must not have the side effect of starting a DM just by
 * inspecting who could message in it. */
export function findUserAgentConversation(
  db: Pick<PrismaClient, "conversation">,
  workspaceId: string,
  userId: string,
  agentId: string,
) {
  return db.conversation.findUnique({
    where: { workspaceId_directKey: { workspaceId, directKey: agentDirectKey(userId, agentId) } },
    select: { id: true },
  });
}
