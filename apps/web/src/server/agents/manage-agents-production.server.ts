import type { PrismaClient as Database } from "#src/generated/prisma/client";
import { PrismaAgentRepository } from "#src/server/db/repositories/agent.repositories.server";
import { PrismaAgentRuntimeCredentialRepository } from "#src/server/db/repositories/agent-runtime-credential.repositories.server";
import { ManageAgents } from "./manage-agents.server";
import { getAgentRuntimeLock } from "./agent-runtime-lock.server";
import { userAgentRuntimeControl } from "./user-agent-control.server";
import { computerCanRunAgent } from "./computer-runtime-availability.server";
import {
  AgentRuntimeCredentials,
  readAgentRuntimeCredentialEncryptionKey,
} from "./agent-runtime-credentials.server";

export function manageAgents(db: Database) {
  const agents = new PrismaAgentRepository(db);
  const runtimeLock = getAgentRuntimeLock();
  const agentManagement = new ManageAgents(
    agents,
    {
      start: (intent, ownerId) => userAgentRuntimeControl(db, agents).start(intent, ownerId),
      stop: (intent, ownerId) => userAgentRuntimeControl(db, agents).stop(intent, ownerId),
    },
    {
      canRun: (workspaceId, userId, computerId, config) =>
        computerCanRunAgent(db, { workspaceId, userId }, computerId, config),
    },
    runtimeLock,
    () => runtimeCredentials(db, true),
  );
  return agentManagement;
}

export async function runtimeCredentials(db: Database, decrypt = false) {
  return new AgentRuntimeCredentials(
    new PrismaAgentRuntimeCredentialRepository(db),
    decrypt ? await readAgentRuntimeCredentialEncryptionKey(process.env) : undefined,
  );
}
