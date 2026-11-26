import { recordChannelMembersRemoved } from "#src/server/app-notifications/channel-events.server";
import type { PrismaClient } from "#src/generated/prisma/client";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { ACTIVE_CHANNEL_MEMBER_WHERE } from "#src/server/conversations/active-member.server";
import { clearOnboardingAgent } from "#src/server/workspaces/workspace-onboarding.server";
import { recordMembershipNotices } from "#src/server/conversations/channel-membership-notice.server";
import { settlePendingNotLaunched } from "#src/server/db/repositories/mention-delivery.repositories.server";
import { auditExternalCredential } from "#src/server/agents/external-agent-credentials.server";
import { revokeExternalCredentialsOf } from "#src/server/db/repositories/external-agent-credential.repositories.server";
import type {
  AgentDeletionOutcome,
  AgentDeletionStore,
} from "#src/server/agents/agent-deletion.server";

export class PrismaAgentDeletionStore implements AgentDeletionStore {
  constructor(private readonly db: PrismaClient) {}

  async delete(input: {
    agentId: string;
    workspaceId: string;
    deletedAt: Date;
    deletedByUserId?: string;
  }): Promise<AgentDeletionOutcome> {
    return this.db.$transaction(async (tx) => {
      const assistant = await tx.weeklyReportAssistant.findFirst({
        where: { agentId: input.agentId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      if (assistant) return { outcome: "protected" as const };
      const platformAssistant = await tx.workspaceAssistantSession.findFirst({
        where: { agentId: input.agentId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      if (platformAssistant) return { outcome: "protected" as const };
      const deleted = await tx.agent.updateMany({
        where: { id: input.agentId, workspaceId: input.workspaceId, ...ACTIVE_AGENT_WHERE },
        data: { deletedAt: input.deletedAt, deletedByUserId: input.deletedByUserId ?? null },
      });
      if (deleted.count === 0) return { outcome: "already-deleted" as const };
      await clearOnboardingAgent(tx, input.workspaceId, input.agentId);

      const activeChannels = await tx.conversationMember.findMany({
        orderBy: { conversationId: "asc" },
        where: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          ...ACTIVE_CHANNEL_MEMBER_WHERE,
        },
        select: { conversationId: true },
      });
      const membershipsLeft = await tx.conversationMember.updateMany({
        where: { workspaceId: input.workspaceId, agentId: input.agentId, leftAt: null },
        data: { leftAt: input.deletedAt },
      });
      const leftChannelIds = activeChannels.map((row) => row.conversationId);
      await recordChannelMembersRemoved(tx, input.workspaceId, leftChannelIds, {
        agentId: input.agentId,
      });
      const membershipNotices = await recordMembershipNotices(tx, {
        workspaceId: input.workspaceId,
        conversationIds: leftChannelIds,
        kind: "channel.member_removed",
        actors: [{ agentId: input.agentId }],
        ...(input.deletedByUserId ? { operator: { userId: input.deletedByUserId } } : {}),
      });
      const remindersCanceled = await tx.reminder.updateMany({
        where: {
          workspaceId: input.workspaceId,
          ownerAgentId: input.agentId,
          status: "scheduled",
        },
        data: { status: "canceled" },
      });
      await settlePendingNotLaunched(tx, {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        settledAt: input.deletedAt,
      });
      const apiKeysRevoked = await tx.agentApiKey.updateMany({
        where: { agentId: input.agentId, workspaceId: input.workspaceId, revokedAt: null },
        data: { revokedAt: input.deletedAt },
      });
      const externalRevoked = await revokeExternalCredentialsOf(
        tx,
        input.agentId,
        "agent_deleted",
        input.deletedAt,
      );
      if (externalRevoked.count > 0)
        auditExternalCredential("credentials_revoked", {
          agentId: input.agentId,
          workspaceId: input.workspaceId,
          reason: "agent_deleted",
          count: externalRevoked.count,
          actorUserId: input.deletedByUserId ?? null,
        });
      return {
        outcome: "deleted" as const,
        membershipsLeft: membershipsLeft.count,
        membershipNotices,
        leftChannelIds,
        remindersCanceled: remindersCanceled.count,
        apiKeysRevoked: apiKeysRevoked.count,
      };
    });
  }
}
