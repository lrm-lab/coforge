import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { agentMascot } from "#src/features/agents/agent-mascot";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";
import { APP_BOT_LOGO_SELECT, agentFaceUrl } from "#src/server/apps/app-logo.server";
import { getAgentDisplay, type AgentDisplay } from "#src/server/agents/agent-display.server";
import { getAgentStatusCache, type AgentStatusCache } from "#src/server/agents/agent-status.server";
import { agentDisplayScope } from "#src/server/agents/external-agent-presence.server";
import { publicAgentRuntimeConfig } from "#src/server/agents/agent-runtime-config.server";
import { ACTIVE_AGENT_WHERE, ROSTER_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import {
  canSeeAgent,
  viewerCreatorId,
  visibleAgentWhere,
  type AgentVisibilityViewer,
} from "#src/server/agents/agent-visibility.server";
import {
  projectExtraAgentRow,
  selectExtraAgentDisplayScopes,
} from "#src/server/agents/extra-agents.server";
import {
  AGENT_RECORD_SELECT,
  PrismaAgentRepository,
  mapAgent,
  type AgentRecord,
} from "#src/server/db/repositories/agent.repositories.server";
import { WEEKLY_REPORTS_VISIBLE_AGENT_WHERE } from "#src/server/records/weekly-reports-gate.server";

type RosterPorts = {
  statuses?: Pick<AgentStatusCache, "snapshotMany">;
  displays?: Pick<AgentDisplay, "snapshotMany" | "busyScopes">;
  now?: number;
};

type AppBotFace = Parameters<typeof agentFaceUrl>[0]["appBot"];

async function loadAppBotFacesByAgentId(
  db: Pick<PrismaClient, "appInstallationBot">,
  agentIds: readonly string[],
): Promise<Map<string, AppBotFace>> {
  if (agentIds.length === 0) return new Map();
  const matched = await db.appInstallationBot
    .findMany({
      where: { agentId: { in: [...agentIds] } },
      select: { agentId: true },
    })
    .catch(() => []);
  if (matched.length === 0) return new Map();
  const botRows = await db.appInstallationBot
    .findMany({
      where: { agentId: { in: matched.map((row) => row.agentId) } },
      select: { agentId: true, ...APP_BOT_LOGO_SELECT.select },
    })
    .catch(() => []);
  return new Map(botRows.map((bot) => [bot.agentId, bot]));
}

function projectRosterAgents(
  agents: readonly AgentRecord[],
  botByAgentId: ReadonlyMap<string, AppBotFace>,
  statusByAgentId: ReadonlyMap<
    string,
    Awaited<ReturnType<AgentStatusCache["snapshotMany"]>>[number]
  >,
  displayByAgentId: ReadonlyMap<string, AgentDisplaySnapshot | undefined>,
) {
  return agents.map((agent) => {
    const status = statusByAgentId.get(agent.id);
    const displaySnapshot = displayByAgentId.get(agent.id);
    const mascot = agentMascot(agent.id, agent.avatarMascot);
    return {
      ...agent,
      runtimeConfig: publicAgentRuntimeConfig(agent.runtimeConfig),
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

export async function readAgentRoster(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  ports?: RosterPorts,
) {
  const agents = await new PrismaAgentRepository(db).listOwnedInWorkspace(workspaceId, userId);
  if (agents.length === 0) return [];
  const statuses = ports?.statuses ?? getAgentStatusCache();
  const displays = ports?.displays ?? getAgentDisplay();
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
  const [botByAgentId, statusSnapshots, displaySnapshots] = await Promise.all([
    loadAppBotFacesByAgentId(
      db,
      agents.map((agent) => agent.id),
    ),
    statusScopes.length > 0 ? statuses.snapshotMany(statusScopes) : Promise.resolve([]),
    displayed.length > 0
      ? displays.snapshotMany(displayed.map(({ scope }) => scope)).catch(() => [])
      : Promise.resolve([]),
  ]);
  const statusByAgentId = new Map(
    scoped.map((agent, index) => [agent.id, statusSnapshots[index]] as const),
  );
  const displayByAgentId = new Map(
    displayed.map(({ agent }, index) => [agent.id, displaySnapshots[index]] as const),
  );
  return projectRosterAgents(agents, botByAgentId, statusByAgentId, displayByAgentId);
}

export async function loadWorkspaceAgentsSnapshot(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
  viewer: AgentVisibilityViewer | undefined,
  ports?: RosterPorts,
) {
  const statuses = ports?.statuses ?? getAgentStatusCache();
  const displays = ports?.displays ?? getAgentDisplay();
  const now = ports?.now ?? Date.now();
  const [allRows, busy] = await Promise.all([
    db.agent.findMany({
      where: {
        AND: [
          { workspaceId, ...ACTIVE_AGENT_WHERE },
          ROSTER_AGENT_WHERE,
          WEEKLY_REPORTS_VISIBLE_AGENT_WHERE,
        ],
      },
      select: AGENT_RECORD_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    viewer ? displays.busyScopes(workspaceId, now).catch(() => []) : Promise.resolve([]),
  ]);
  const statusAgents = allRows.map(({ id, computerId }) => ({ id, computerId }));
  const ownedAgents = allRows.filter((row) => row.ownerId === userId).map(mapAgent);
  const extraRows = viewer
    ? allRows
        .filter((row) => row.ownerId !== viewerCreatorId(viewer) && canSeeAgent(viewer, row))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    : undefined;

  const ownedStatusScoped = ownedAgents.filter((agent) => agent.computerId);
  const statusScopes = ownedStatusScoped.map((agent) => ({
    workspaceId,
    computerId: agent.computerId as string,
    agentId: agent.id,
  }));
  const ownedDisplayed = ownedAgents.flatMap((agent) => {
    const scope = agentDisplayScope(workspaceId, agent);
    return scope ? [{ id: agent.id, scope }] : [];
  });
  const extraDisplayed = extraRows
    ? selectExtraAgentDisplayScopes(workspaceId, extraRows, busy, [], true).map(
        ({ row, scope }) => ({ id: row.id, scope }),
      )
    : [];
  const combinedDisplayed = [...ownedDisplayed, ...extraDisplayed];
  const visibleAgentIds = [
    ...ownedAgents.map((agent) => agent.id),
    ...(extraRows?.map((row) => row.id) ?? []),
  ];

  const [botByAgentId, statusSnapshots, displaySnapshots] = await Promise.all([
    loadAppBotFacesByAgentId(db, visibleAgentIds),
    statusScopes.length > 0 ? statuses.snapshotMany(statusScopes) : Promise.resolve([]),
    combinedDisplayed.length > 0
      ? displays.snapshotMany(combinedDisplayed.map(({ scope }) => scope)).catch(() => [])
      : Promise.resolve([]),
  ]);

  const statusByAgentId = new Map(
    ownedStatusScoped.map((agent, index) => [agent.id, statusSnapshots[index]] as const),
  );
  const displayByAgentId = new Map(
    combinedDisplayed.map(({ id }, index) => [id, displaySnapshots[index]] as const),
  );
  const agents = projectRosterAgents(ownedAgents, botByAgentId, statusByAgentId, displayByAgentId);
  const extraAgents = extraRows?.map((row) =>
    projectExtraAgentRow(
      { ...row, appBot: botByAgentId.get(row.id) },
      displayByAgentId.get(row.id),
    ),
  );
  return { agents, extraAgents, statusAgents };
}

export async function statusAgentScopes(db: Pick<PrismaClient, "agent">, workspaceId: string) {
  return db.agent.findMany({
    where: {
      AND: [
        { workspaceId, ...ACTIVE_AGENT_WHERE },
        ROSTER_AGENT_WHERE,
        WEEKLY_REPORTS_VISIBLE_AGENT_WHERE,
      ],
    },
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
        WEEKLY_REPORTS_VISIBLE_AGENT_WHERE,
      ],
    },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}
