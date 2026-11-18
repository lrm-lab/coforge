import type { RuntimeMetadata, RuntimeProvider } from "@lrm/coforge-sdk/internal";

import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { PrismaAgentControlStore } from "#src/server/db/repositories/agent-control.repositories.server";
import { agentStartIntent } from "./manage-agents.server";
import { userAgentControl } from "./user-agent-control.server";

type RecoverableAgent = { stoppedAt?: unknown; deletedAt?: unknown; migrating?: unknown };

export type InventoryAgentRecoveryPorts<Agent extends RecoverableAgent> = {
  failedAgentIds(provider: RuntimeProvider, errorCode: string): Promise<string[]>;
  clearLaunchFailure(agentId: string, errorCode: string): Promise<boolean>;
  agent(agentId: string): Promise<Agent | null | undefined>;
  start(agent: Agent): Promise<void>;
};

const RECOVERABLE_LAUNCH_FAILURES = [
  { errorCode: "runtime_not_installed", onlyWhenNewlyUsable: false },
  { errorCode: "runtime_version_too_old", onlyWhenNewlyUsable: true },
] as const;

type ReportedRuntime = { provider: RuntimeProvider; unavailableCode?: string | null };

const usable = (runtimes: readonly ReportedRuntime[]) =>
  new Set(
    runtimes.filter((runtime) => !runtime.unavailableCode).map((runtime) => runtime.provider),
  );

export async function recoverAgentsAfterInventory<Agent extends RecoverableAgent>(
  ports: InventoryAgentRecoveryPorts<Agent>,
  before: readonly ReportedRuntime[],
  runtimes: readonly RuntimeMetadata[],
): Promise<void> {
  const wasUsable = usable(before);
  for (const provider of usable(runtimes)) {
    for (const { errorCode, onlyWhenNewlyUsable } of RECOVERABLE_LAUNCH_FAILURES) {
      if (onlyWhenNewlyUsable && wasUsable.has(provider)) continue;
      for (const agentId of await ports.failedAgentIds(provider, errorCode)) {
        if (!(await ports.clearLaunchFailure(agentId, errorCode))) continue;
        const agent = await ports.agent(agentId);
        if (!agent || agent.stoppedAt || agent.deletedAt || agent.migrating) continue;
        await ports.start(agent).catch(() => {});
      }
    }
  }
}

export function productionInventoryAgentRecovery(
  db: PrismaClient,
  scope: { workspaceId: string; computerId: string },
) {
  const inventory = new PrismaComputerRuntimeRepository(db);
  const control = userAgentControl(db);
  const store = new PrismaAgentControlStore(db);
  return {
    before: () => inventory.listInWorkspace(scope.workspaceId, [scope.computerId]),
    failedAgentIds: (provider: RuntimeProvider, errorCode: string) =>
      inventory.findFailedAgentIdsForRuntime(
        scope.workspaceId,
        scope.computerId,
        provider,
        errorCode,
      ),
    clearLaunchFailure: (agentId: string, errorCode: string) =>
      control.clearLaunchFailure(agentId, errorCode),
    agent: (agentId: string) => store.get(agentId),
    start: async (agent: NonNullable<Awaited<ReturnType<PrismaAgentControlStore["get"]>>>) => {
      await control.recover(agentStartIntent(agent), agent.ownerId);
    },
  };
}
