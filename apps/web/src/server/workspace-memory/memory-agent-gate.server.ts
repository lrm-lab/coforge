import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaExperimentsRepository } from "#src/server/experiments/experiments.repositories.server";
import { Experiments } from "#src/server/experiments/experiments.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import type { PrototypeGate, PrototypeGateSource } from "./profile";
import { isOpenVikingPrototypeEnabled } from "./prototype-gate";

/**
 * Both switches the Memory Agent answers to, in this order (task #6): `OPENVIKING_PROTOTYPE_ENABLED`
 * stays the deployment's master switch, and the Workspace's own `memoryAgent` experiment is the
 * second. They combine into the one `PrototypeGate` the agent already had — no second "disabled"
 * state to keep in step, and turning the experiment off is "the workspace is asked, and says no".
 */
export function memoryAgentGateFrom(
  deploymentEnabled: boolean,
  workspaceEnabled: boolean,
): PrototypeGate {
  return { prototypeEnabled: deploymentEnabled && workspaceEnabled };
}

export async function memoryAgentGate(
  db: PrismaClient,
  workspaceId: string,
): Promise<PrototypeGate> {
  if (!isOpenVikingPrototypeEnabled(Bun.env)) return memoryAgentGateFrom(false, false);
  const workspaceEnabled = await new Experiments(
    new PrismaExperimentsRepository(db),
    isFeatureEnabled,
  ).enabled("memoryAgent", { workspaceId });
  return memoryAgentGateFrom(true, workspaceEnabled);
}

/** The same gate as a per-Workspace source, for the profile API and the admission sweep, which ask
 * once per Workspace in the loop they already run. */
export function memoryAgentGateSource(db: PrismaClient): PrototypeGateSource {
  return (workspaceId) => memoryAgentGate(db, workspaceId);
}
