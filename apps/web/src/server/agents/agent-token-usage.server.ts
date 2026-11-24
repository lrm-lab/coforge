import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import {
  aggregateAgentTokenUsageSlices,
  queryWindowStart,
  type AgentTokenUsageRange,
  type AgentTokenUsageReport,
} from "#src/features/agents/agent-token-usage-model";
import {
  buildWorkspaceAgentUsageReport,
  type WorkspaceAgentUsageReport,
} from "#src/features/agents/workspace-agent-usage-model";
import { AppError } from "#src/lib/app-error";
import { resolveTimeZone } from "#src/lib/dates";
import { humanLabel } from "#src/lib/human-label";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { readableRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { managedAgentWhere } from "#src/server/agents/agent-visibility.server";
import { agentFaceUrl } from "#src/server/apps/app-logo.server";
import { PrismaAgentTokenUsageRepository } from "#src/server/db/repositories/agent-token-usage.repositories.server";
import { workspaceUserAvatarUrl } from "#src/server/db/repositories/user-profile.repositories.server";

export async function loadAgentTokenUsage(
  context: WorkspaceUserContext,
  input: {
    agentId: string;
    range: AgentTokenUsageRange;
    timeZone?: string | null;
  },
): Promise<AgentTokenUsageReport> {
  const { user, db, workspaceId } = context;
  const agent = await db.agent.findFirst({
    where: {
      id: input.agentId,
      ...ACTIVE_AGENT_WHERE,
      hosting: { not: "external" },
      AND: [
        managedAgentWhere({ userId: user.id, workspaceId }),
        { OR: [{ systemKind: null }, { systemKind: { not: "app-bot" } }] },
      ],
    },
    select: {
      id: true,
      computerId: true,
    },
  });
  if (!agent) throw new AppError("NOT_FOUND");

  const now = new Date();
  const timeZone = resolveTimeZone(input.timeZone);
  const since = queryWindowStart(input.range, timeZone, now);
  const repo = new PrismaAgentTokenUsageRepository(db);
  const [slices, trackingStartedAt, display] = await Promise.all([
    repo.aggregateTurnsInRange({
      workspaceId,
      agentId: agent.id,
      since,
      timeZone,
      byHour: input.range === 1,
    }),
    repo.findEarliestRecordedAt({ workspaceId, agentId: agent.id }),
    agent.computerId
      ? getAgentDisplay()
          .snapshot({ workspaceId, computerId: agent.computerId, agentId: agent.id })
          .catch(() => undefined)
      : Promise.resolve(undefined),
  ]);

  return aggregateAgentTokenUsageSlices({
    slices,
    range: input.range,
    timeZone,
    now,
    trackingStartedAt,
    liveContextUsage: display?.contextUsage ?? null,
  });
}

export async function loadWorkspaceAgentTokenUsage(
  context: WorkspaceUserContext,
  input: {
    range: AgentTokenUsageRange;
    timeZone?: string | null;
  },
): Promise<WorkspaceAgentUsageReport> {
  const { user, db, workspaceId } = context;
  const agents = await db.agent.findMany({
    where: {
      hosting: { not: "external" },
      AND: [
        {
          OR: [
            ACTIVE_AGENT_WHERE,
            { deletedAt: { not: null }, tokenUsageTurns: { some: { workspaceId } } },
          ],
        },
        managedAgentWhere({ userId: user.id, workspaceId }),
        { OR: [{ systemKind: null }, { systemKind: { not: "app-bot" } }] },
      ],
    },
    select: {
      id: true,
      name: true,
      displayName: true,
      avatarMascot: true,
      runtimeConfig: true,
      deletedAt: true,
      owner: {
        select: {
          id: true,
          username: true,
          displayName: true,
          avatarObjectKey: true,
        },
      },
    },
  });

  const now = new Date();
  const timeZone = resolveTimeZone(input.timeZone);
  const since = queryWindowStart(input.range, timeZone, now);
  const repo = new PrismaAgentTokenUsageRepository(db);
  const agentIds = agents.map((agent) => agent.id);
  const [slices, trackingStartedAt] = await Promise.all([
    repo.aggregateWorkspaceAgentsInRange({
      workspaceId,
      agentIds,
      since,
      timeZone,
      byHour: input.range === 1,
    }),
    repo.findWorkspaceEarliestRecordedAt({ workspaceId, agentIds }),
  ]);

  return buildWorkspaceAgentUsageReport({
    agents: agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName?.trim() || agent.name,
      avatarUrl: agentFaceUrl(agent),
      model: readableRuntimeConfig(agent.runtimeConfig, agent.id)?.model ?? "",
      ownerId: agent.owner.id,
      ownerDisplayName: humanLabel(agent.owner),
      ownerAvatarUrl: workspaceUserAvatarUrl(
        workspaceId,
        agent.owner.id,
        agent.owner.avatarObjectKey,
      ),
      archived: agent.deletedAt !== null,
    })),
    slices,
    range: input.range,
    timeZone,
    now,
    trackingStartedAt,
  });
}
