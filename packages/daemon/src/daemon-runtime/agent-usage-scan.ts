import { UsageUnavailableError } from "@lrm/coforge-anvil";
import { RUNTIME_PROVIDER, type UsageScanResponse } from "@lrm/coforge-sdk/internal";
import type { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import { USAGE_SCAN_READ_TIMEOUT_MS } from "./runtime-agent-flows";
import { usageScanFailure, usageScanReading } from "./usage-scan-response";

export type AgentUsageScanScope = { agentId: string; expectedRuntimeConfigRevision: number };
export type AgentUsageScanResult = UsageScanResponse & { effectiveRuntimeConfigRevision: number };

export async function scanAgentUsage(
  agents: Pick<AgentProcessManager, "runtime" | "isStopping">,
  { agentId, expectedRuntimeConfigRevision }: AgentUsageScanScope,
): Promise<AgentUsageScanResult | undefined> {
  const active = agents.runtime(agentId);
  if (
    !active ||
    active.config.provider !== RUNTIME_PROVIDER.CODEX ||
    active.effectiveConfigRevision !== expectedRuntimeConfigRevision ||
    agents.isStopping(agentId) ||
    !active.session.readUsage
  )
    return undefined;
  const now = () => new Date();
  let reading: UsageScanResponse;
  try {
    const snapshot = await active.session.readUsage(USAGE_SCAN_READ_TIMEOUT_MS);
    if (!snapshot) throw new UsageUnavailableError();
    reading = usageScanReading(snapshot, now);
  } catch (error) {
    reading = usageScanFailure(error, () => undefined, now);
  }
  if (agents.runtime(agentId) !== active || agents.isStopping(agentId)) return undefined;
  return { ...reading, effectiveRuntimeConfigRevision: active.effectiveConfigRevision };
}
