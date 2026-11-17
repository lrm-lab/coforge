import type { PrismaClient } from "#src/generated/prisma/client";
import { agentMascot } from "#src/features/agents/agent-mascot";
import { agentFaceUrl } from "#src/server/apps/app-logo.server";
import { getAgentDisplay } from "#src/server/agents/agent-display.server";
import { getAgentStatusCache } from "#src/server/agents/agent-status.server";
import { agentDisplayScope } from "#src/server/agents/external-agent-presence.server";
import { manageAgents } from "#src/server/agents/manage-agents-production.server";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";

export async function readAgentRoster(db: PrismaClient, userId: string, workspaceId: string) {
  const agents = await manageAgents(db).list({ userId, workspaceId });
  const statuses = getAgentStatusCache();
  const botRows = await db.appInstallationBot
    .findMany({
      where: { agentId: { in: agents.map((agent) => agent.id) } },
      select: {
        agentId: true,
        installation: {
          select: { app: { select: { key: true, ownerWorkspaceId: true, logoObjectKey: true } } },
        },
      },
    })
    .catch(() => []);
  const scoped = agents.filter((agent) => agent.computerId);
  const statusScopes = scoped.map((agent) => ({
    workspaceId,
    computerId: agent.computerId as string,
    agentId: agent.id,
  }));
  const displayed = agents.flatMap((agent) => {
    const scope = agentDisplayScope(workspaceId, agent);
    return scope ? [{ agent, scope }] : [];
  });
  const [statusSnapshots, displaySnapshots] = await Promise.all([
    statuses.snapshotMany(statusScopes),
    getAgentDisplay()
      .snapshotMany(displayed.map(({ scope }) => scope))
      .catch(() => []),
  ]);
  const statusByAgentId = new Map(
    scoped.map((agent, index) => [agent.id, statusSnapshots[index]] as const),
  );
  const botByAgentId = new Map(botRows.map((bot) => [bot.agentId, bot]));
  const displayByAgentId = new Map(
    displayed.map(({ agent }, index) => [agent.id, displaySnapshots[index]] as const),
  );
  return agents.map((agent) => {
    const status = statusByAgentId.get(agent.id);
    const displaySnapshot = displayByAgentId.get(agent.id);
    const mascot = agentMascot(agent.id, agent.avatarMascot);
    return {
      ...agent,
      mascot,
      avatarUrl: agentFaceUrl({
        id: agent.id,
        avatarMascot: agent.avatarMascot,
        appBot: botByAgentId.get(agent.id),
      }),
      stopped: Boolean(agent.stoppedAt),
      ...(displaySnapshot ? { display: displaySnapshot } : {}),
      status: {
        value: status?.status ?? ("inactive" as const),
        expiresAt: status?.expiresAt ?? null,
        ordering: status
          ? {
              daemonInstanceId: status.daemonInstanceId,
              clientSeq: status.clientSeq,
              observedAtMs: status.observedAtMs,
            }
          : null,
      },
    };
  });
}

export async function statusAgentScopes(db: Pick<PrismaClient, "agent">, workspaceId: string) {
  return db.agent.findMany({
    where: { workspaceId, ...ACTIVE_AGENT_WHERE, ...ROSTER_AGENT_WHERE },
    select: { id: true, computerId: true },
  });
}

export async function visiblePrivateAgentIds(
  db: Pick<PrismaClient, "agent">,
  workspaceId: string,
  viewer: AgentVisibilityViewer,
) {
  const rows = await db.agent.findMany({
    where: {
      AND: [
        { workspaceId, ...ACTIVE_AGENT_WHERE, visibility: AGENT_VISIBILITY.PRIVATE },
        visibleAgentWhere(viewer),
        ROSTER_AGENT_WHERE,
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
