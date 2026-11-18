import type { ComputerUpgradeStatus } from "#src/features/computers/computer.schemas";
import { agentReadiness, READY, type AgentReadiness } from "./agent-readiness.server";
import type {
  AgentRuntimeSelection,
  AgentRuntimeSelectionRefusal,
} from "./agent-runtime-availability.server";

export type AgentReadinessPorts = {
  latestUpgrade(computerId: string): Promise<ComputerUpgradeStatus | undefined>;
  runtimeRefusal(
    computerId: string,
    selection: AgentRuntimeSelection,
  ): Promise<AgentRuntimeSelectionRefusal | null>;
};

export type AgentReadinessReads = {
  upgradeExpiresAtMs: number | null;
  runtimeRefusal: AgentRuntimeSelectionRefusal | null;
};

const NO_NEWS: AgentReadinessReads = { upgradeExpiresAtMs: null, runtimeRefusal: null };

export async function readAgentReadinessInputs(
  ports: AgentReadinessPorts,
  facts: { computerId: string | undefined; selection: AgentRuntimeSelection | undefined },
): Promise<AgentReadinessReads> {
  const { computerId, selection } = facts;
  if (!computerId) return NO_NEWS;
  const [upgrade, runtimeRefusal] = await Promise.all([
    ports.latestUpgrade(computerId).catch(() => undefined),
    selection ? ports.runtimeRefusal(computerId, selection).catch(() => null) : null,
  ]);
  return {
    upgradeExpiresAtMs: upgrade?.status === "accepted" ? Date.parse(upgrade.expiresAt) : null,
    runtimeRefusal,
  };
}

export function agentReadinessOf(
  reads: AgentReadinessReads,
  facts: {
    nowMs: number;
    computerId: string | undefined;
    computerOnline: boolean | undefined;
    stopReason: string | null;
    failureReason: string | null;
  },
): AgentReadiness {
  if (!facts.computerId || facts.computerOnline === undefined) return READY;
  return agentReadiness({
    nowMs: facts.nowMs,
    computerOnline: facts.computerOnline,
    upgradeExpiresAtMs: reads.upgradeExpiresAtMs,
    runtimeRefusal: facts.computerOnline ? reads.runtimeRefusal : null,
    stopReason: facts.stopReason,
    failureReason: facts.failureReason,
  });
}
