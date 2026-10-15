import type { PrismaClient } from "#src/generated/prisma/client";
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
import { getAgentMigrationStorage } from "./agent-migration-storage.server";
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

/** The migration use cases wired to one database, the migration bucket and Centrifugo. */
export async function agentMigrationServices(db: PrismaClient) {
  const migrations = new AgentMigrations(new PrismaAgentMigrationStore(db));
  return {
    migrations,
    transport: new AgentMigrationTransport(migrations, await getAgentMigrationStorage()),
    orchestrator: new AgentMigrationOrchestrator({
      migrations,
      dispatch: new AgentMigrationDispatch(createCentrifugoServerApi()),
      runtime: agentMigrationRuntime(db),
      lock: getAgentRuntimeLock(),
    }),
  };
}
