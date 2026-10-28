import type { TaskCommand, TaskPrincipal } from "@lrm/coforge-sdk/internal";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import type { HumanNames } from "#src/lib/human-label";
import { AppError } from "#src/lib/app-error";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { TASK_SCOPE_WHERE } from "./task-view.server";

/** The authorized conversation seat used by Task writes and history. */
export type TaskConversationMember = {
  id: string;
  userId: string | null;
  agentId: string | null;
  user?: HumanNames | null;
  agent?: { name: string; displayName?: string | null } | null;
};
const MEMBER_SELECT = {
  id: true,
  userId: true,
  agentId: true,
  user: { select: { username: true, displayName: true } },
  agent: { select: { name: true, displayName: true } },
} satisfies Prisma.ConversationMemberSelect;

/** Resolve task scope through current membership; execution reports use stable conversation ids. */
export async function resolveTaskConversation(
  db: PrismaClient,
  principal: TaskPrincipal,
  command: TaskCommand,
): Promise<{
  conversationId: string;
  workspaceId: string;
  channel: boolean;
  channelName: string | null;
  member: TaskConversationMember | undefined;
}> {
  if ((principal.userId ? 1 : 0) + (principal.agentId ? 1 : 0) !== 1)
    throw new AppError("ACCESS_DENIED");
  if (principal.userId) {
    if (command.target || !command.conversationId) throw new AppError("INVALID_INPUT");
    const workspaceMember = await db.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: principal.workspaceId,
          userId: principal.userId,
        },
      },
    });
    if (!workspaceMember) throw new AppError("ACCESS_DENIED");
    const conversation = await db.conversation.findFirst({
      where: {
        id: command.conversationId,
        workspaceId: principal.workspaceId,
        ...TASK_SCOPE_WHERE,
      },
      select: {
        id: true,
        workspaceId: true,
        channelName: true,
        directKey: true,
        // Someone who left the conversation is no longer its member and cannot act on its Tasks.
        members: {
          where: { userId: principal.userId, ...ACTIVE_MEMBER_WHERE },
          select: MEMBER_SELECT,
        },
      },
    });
    if (!conversation) throw new AppError("NOT_FOUND");
    // A direct conversation's Tasks belong to the people its key names, not to whoever holds
    // a member row.
    if (
      conversation.directKey !== null &&
      !conversation.directKey.split(/[|:]/).includes(principal.userId)
    )
      throw new AppError("ACCESS_DENIED");
    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      channel: conversation.channelName !== null,
      channelName: conversation.channelName,
      member: conversation.members[0],
    };
  }
  const agent = await db.agent.findFirst({
    where: { id: principal.agentId, workspaceId: principal.workspaceId, ...ACTIVE_AGENT_WHERE },
    select: { id: true },
  });
  if (!agent) throw new AppError("ACCESS_DENIED");
  if (command.operation === "execution" && command.conversationId) {
    const conversation = await db.conversation.findFirst({
      where: {
        id: command.conversationId,
        workspaceId: principal.workspaceId,
        channelName: { not: null },
        ...TASK_SCOPE_WHERE,
        members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } },
      },
      select: {
        id: true,
        workspaceId: true,
        channelName: true,
        members: {
          where: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE },
          select: MEMBER_SELECT,
        },
      },
    });
    if (!conversation) throw new AppError("ACCESS_DENIED");
    return {
      conversationId: conversation.id,
      workspaceId: conversation.workspaceId,
      channel: true,
      channelName: conversation.channelName,
      member: conversation.members[0],
    };
  }
  if (command.conversationId || !command.target) throw new AppError("INVALID_INPUT");
  const target = command.target!;
  if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target) && !/^@[a-z0-9][a-z0-9_-]{0,31}$/.test(target))
    throw new AppError("INVALID_INPUT");
  const targetUser = target.startsWith("@")
    ? await db.user.findFirst({
        where: {
          username: target.slice(1),
          memberships: { some: { workspaceId: principal.workspaceId } },
        },
        select: { id: true },
      })
    : null;
  if (target.startsWith("@") && !targetUser) throw new AppError("NOT_FOUND");
  const conversation = target.startsWith("#")
    ? await db.conversation.findFirst({
        where: {
          workspaceId: principal.workspaceId,
          channelName: target.slice(1),
          ...TASK_SCOPE_WHERE,
          members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } },
        },
        select: {
          id: true,
          workspaceId: true,
          channelName: true,
          members: {
            where: { agentId: principal.agentId },
            select: MEMBER_SELECT,
          },
        },
      })
    : await db.conversation.findFirst({
        where: {
          workspaceId: principal.workspaceId,
          directKey: { not: null },
          AND: [
            { members: { some: { agentId: principal.agentId, ...ACTIVE_MEMBER_WHERE } } },
            {
              members: {
                some: { user: { username: target.slice(1) }, ...ACTIVE_MEMBER_WHERE },
              },
            },
          ],
        },
        select: {
          id: true,
          workspaceId: true,
          channelName: true,
          members: {
            where: { agentId: principal.agentId },
            select: MEMBER_SELECT,
          },
        },
      });
  if (!conversation) throw new AppError("NOT_FOUND");
  return {
    conversationId: conversation.id,
    workspaceId: conversation.workspaceId,
    channel: conversation.channelName !== null,
    channelName: conversation.channelName,
    member: conversation.members[0],
  };
}
