import type { PrismaClient } from "#src/generated/prisma/client";
import { isAdminLike, type WorkspaceMemberRole } from "#src/server/workspaces/member-role.server";
import {
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import {
  computerCanRunAgent,
  storedRuntimeSelection,
} from "#src/server/agents/computer-runtime-availability.server";
import { ACTIVE_AGENT_WHERE } from "#src/server/agents/active-agent.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getAgentMigrationCapabilityLease } from "./agent-migration-capability.server";
import { getAgentRuntimeLock } from "#src/server/agents/agent-runtime-lock.server";
import { agentStartIntent, agentStopIntent } from "#src/server/agents/manage-agents.server";
import { userAgentRuntimeControl } from "#src/server/agents/user-agent-control.server";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { PrismaAgentMigrationStore } from "#src/server/db/repositories/agent-migration.repositories.server";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { AgentMigrationDispatch } from "./agent-migration-dispatch.server";
import {
  AgentMigrationOrchestrator,
  type AgentMigrationRuntime,
} from "./agent-migration-orchestrator.server";
import {
  getAgentMigrationStorage,
  readAgentMigrationStorageConfig,
} from "./agent-migration-storage.server";
import { AgentMigrationRequests } from "./agent-migration-requests.server";
import { AgentMigrationTransport } from "./agent-migration-transport.server";
import { AgentMigrations } from "./agent-migrations.server";

/**
 * A migration's Agent stopped and started through the same control an owner's own Stop and Start
 * use, on whichever Computer it is placed on, on behalf of its owner.
 */
function agentMigrationRuntime(db: PrismaClient): AgentMigrationRuntime {
  const agents = new PrismaAgentRepository(db);
  const control = userAgentRuntimeControl(db, agents);
  const load = async (scope: { workspaceId: string; agentId: string }) => {
    const agent = await agents.getById(scope.agentId);
    if (!agent || agent.workspaceId !== scope.workspaceId || !agent.computerId)
      throw new Error("the migrating Agent is no longer placed in its Workspace");
    return agent;
  };
  return {
    stoppedByUser: async (scope) => Boolean((await load(scope)).stoppedAt),
    stop: async (scope) => {
      const agent = await load(scope);
      await control.stop(agentStopIntent(agent), agent.ownerId);
    },
    start: async (scope) => {
      const agent = await load(scope);
      await control.start(agentStartIntent(agent), agent.ownerId);
    },
  };
}

/** The orchestration wired to one database and Centrifugo; it never needs the bucket. */
export function agentMigrationOrchestrator(
  db: PrismaClient,
  migrations = new AgentMigrations(new PrismaAgentMigrationStore(db)),
) {
  return new AgentMigrationOrchestrator({
    migrations,
    dispatch: new AgentMigrationDispatch(createCentrifugoServerApi()),
    runtime: agentMigrationRuntime(db),
    lock: getAgentRuntimeLock(),
    // A bucket that cannot be set up reads as none here; the bucket's lifecycle rule still clears
    // what a migration left in it.
    bucket: () =>
      getAgentMigrationStorage().catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            event: "agent_migration:bucket_unavailable",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
        return null;
      }),
  });
}

/** The daemons' migration operations, wired to one database, the migration bucket and Centrifugo. */
export async function agentMigrationServices(db: PrismaClient) {
  const migrations = new AgentMigrations(new PrismaAgentMigrationStore(db));
  return {
    migrations,
    transport: new AgentMigrationTransport(migrations, await getAgentMigrationStorage()),
    orchestrator: agentMigrationOrchestrator(db, migrations),
  };
}

/** A person's moves of their Agents, wired to one database. */
export function agentMigrationRequests(db: PrismaClient) {
  const migrations = new AgentMigrations(new PrismaAgentMigrationStore(db));
  return new AgentMigrationRequests({
    migrations,
    orchestrator: () => agentMigrationOrchestrator(db, migrations),
    agentOwner: async (workspaceId, agentId) =>
      (
        await db.agent.findFirst({
          where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
          select: { ownerId: true },
        })
      )?.ownerId,
    isWorkspaceAdmin: async (workspaceId, userId) => {
      const membership = await db.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId } },
        select: { role: true },
      });
      return membership ? isAdminLike(membership.role as WorkspaceMemberRole) : false;
    },
    computerName: async (computerId) => {
      const computer = await db.computer.findUnique({
        where: { id: computerId },
        select: { displayName: true, name: true },
      });
      return computer?.displayName || computer?.name || null;
    },
    // The same check that create and edit place an Agent with, on the Agent's stored selection.
    canRunAgent: async (workspaceId, agentId, computerId) => {
      const agent = await db.agent.findFirst({
        where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
        select: { ownerId: true, runtimeConfig: true },
      });
      if (!agent) return false;
      let config: AgentRuntimeConfig;
      try {
        config = parseAgentRuntimeConfig(agent.runtimeConfig);
      } catch {
        return false;
      }
      return computerCanRunAgent(
        db,
        { workspaceId, userId: agent.ownerId },
        computerId,
        storedRuntimeSelection(config),
      );
    },
    agentComputer: async (workspaceId, agentId) =>
      (
        await db.agent.findFirst({
          where: { id: agentId, workspaceId, ...ACTIVE_AGENT_WHERE },
          select: { computerId: true },
        })
      )?.computerId ?? null,
    // Connected, from the Computer status cache; able to move Agents, from what its daemon's last
    // ready said, which a heartbeat keeps alive.
    computerReadiness: async (workspaceId, computerId) => {
      const [online, supported] = await Promise.all([
        getComputerStatusCache()
          .get({ workspaceId, computerId })
          .catch(() => false),
        getAgentMigrationCapabilityLease()
          .supports(workspaceId, computerId)
          .catch(() => false),
      ]);
      if (supported) return "ready";
      return online ? "outdated" : "offline";
    },
    otherComputers: async (workspaceId, exceptComputerId) =>
      (
        await db.workspaceComputer.findMany({
          where: {
            workspaceId,
            computer: { deletedAt: null },
            ...(exceptComputerId ? { computerId: { not: exceptComputerId } } : {}),
          },
          select: { computer: { select: { id: true, name: true, displayName: true } } },
          orderBy: { computer: { name: "asc" } },
        })
      ).map(({ computer }) => ({ id: computer.id, name: computer.displayName || computer.name })),
    // A misconfigured bucket reads as "not set up" here; the daemons' route reports the error.
    available: async () =>
      (await readAgentMigrationStorageConfig(process.env).catch(() => null)) !== null,
  });
}
