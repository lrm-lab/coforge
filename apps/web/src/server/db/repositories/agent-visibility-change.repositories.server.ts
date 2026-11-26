import { recordChannelMembersRemoved } from "#src/server/app-notifications/channel-events.server";
import { recordMembershipNotices } from "#src/server/conversations/channel-membership-notice.server";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { WORKSPACE_ASSISTANT_KIND } from "#src/features/agents/agent-system-kind";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  ACTIVE_CHANNEL_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";
import { joinGeneralChannel } from "#src/server/conversations/general-channel.server";
import { clearOnboardingAgent } from "#src/server/workspaces/workspace-onboarding.server";
import type {
  AgentVisibilityChangePreview,
  ChangeAgentVisibilityStore,
} from "#src/server/agents/change-agent-visibility.server";

export class PrismaChangeAgentVisibilityStore implements ChangeAgentVisibilityStore {
  constructor(private readonly db: PrismaClient) {}

  async apply(input: {
    agentId: string;
    workspaceId: string;
    visibility: string;
    operatorUserId?: string;
  }): Promise<{
    changed: boolean;
    leftChannelIds: string[];
    joinedChannelIds: string[];
    membershipNotices?: { conversationId: string; messageId: string; sequence: number }[];
  }> {
    return this.db.$transaction(async (tx) => {
      const assistant = await tx.agent.findFirst({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          systemKind: WORKSPACE_ASSISTANT_KIND,
        },
        select: { id: true },
      });
      if (assistant) throw new AppError("ACCESS_DENIED");
      const updated = await tx.agent.updateMany({
        where: {
          id: input.agentId,
          workspaceId: input.workspaceId,
          visibility: { not: input.visibility },
          ...ACTIVE_AGENT_WHERE,
        },
        data: { visibility: input.visibility },
      });
      if (updated.count === 0) return { changed: false, leftChannelIds: [], joinedChannelIds: [] };
      if (input.visibility !== AGENT_VISIBILITY.PRIVATE) {
        const generalId = await joinGeneralChannel(tx, input.workspaceId, input.agentId);
        return { changed: true, leftChannelIds: [], joinedChannelIds: [generalId] };
      }
      await clearOnboardingAgent(tx, input.workspaceId, input.agentId);
      const left = await tx.conversationMember.updateManyAndReturn({
        where: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          ...ACTIVE_CHANNEL_MEMBER_WHERE,
        },
        data: { leftAt: new Date() },
        select: { conversationId: true },
      });
      const leftChannelIds = left.map((row) => row.conversationId);
      await recordChannelMembersRemoved(tx, input.workspaceId, leftChannelIds, {
        agentId: input.agentId,
      });
      const membershipNotices = await recordMembershipNotices(tx, {
        workspaceId: input.workspaceId,
        conversationIds: leftChannelIds,
        kind: "channel.member_removed",
        actors: [{ agentId: input.agentId }],
        ...(input.operatorUserId ? { operator: { userId: input.operatorUserId } } : {}),
      });
      return {
        changed: true,
        leftChannelIds,
        joinedChannelIds: [],
        membershipNotices,
      };
    });
  }

  preview(input: { agentId: string; workspaceId: string }): Promise<AgentVisibilityChangePreview> {
    return previewAgentVisibilityChange(this.db, input);
  }
}

export async function previewAgentVisibilityChange(
  db: Pick<PrismaClient, "agent" | "conversationMember" | "conversation">,
  input: { workspaceId: string; agentId: string },
): Promise<AgentVisibilityChangePreview> {
  const agent = await db.agent.findFirst({
    where: { id: input.agentId, workspaceId: input.workspaceId },
    select: { ownerId: true },
  });
  if (!agent) return { channelNames: [], readOnlyDirectMessageCount: 0 };
  const [channelMemberships, readOnlyDirectMessageCount] = await Promise.all([
    db.conversationMember.findMany({
      where: {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        ...ACTIVE_CHANNEL_MEMBER_WHERE,
        conversation: { channelName: { not: null }, ...VISIBLE_CONVERSATION_WHERE },
      },
      select: { conversation: { select: { channelName: true } } },
    }),
    db.conversation.count({
      where: {
        workspaceId: input.workspaceId,
        directKey: { not: null },
        members: { some: { agentId: input.agentId } },
        NOT: { members: { some: { userId: agent.ownerId } } },
      } satisfies Prisma.ConversationWhereInput,
    }),
  ]);
  return {
    channelNames: channelMemberships
      .map((member) => member.conversation.channelName)
      .filter((name): name is string => name !== null),
    readOnlyDirectMessageCount,
  };
}
