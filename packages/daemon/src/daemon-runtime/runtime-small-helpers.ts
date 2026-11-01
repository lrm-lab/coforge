import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { UsageSnapshot } from "@lrm/coforge-anvil";
import { validUsageWindow } from "./runtime-activity-text";
import { workspaceEnvelope } from "./agent-inbox-factories";

/** The fields every daemon -> server report opens with: this protocol, a fresh request id, and
 * this runtime's own Workspace and Computer. */
export function runtimeEnvelope(connection: { workspaceId: string; computerId: string }) {
  return workspaceEnvelope(connection.workspaceId, connection.computerId);
}

export function currentObservedUsage(
  observed: Map<RuntimeProvider, UsageSnapshot>,
  provider: RuntimeProvider,
): UsageSnapshot | undefined {
  const snapshot = observed.get(provider);
  if (!snapshot) return undefined;
  const now = Date.now();
  const primary = validUsageWindow(snapshot.primary, now);
  const secondary = validUsageWindow(snapshot.secondary, now);
  if (!primary && !secondary) {
    observed.delete(provider);
    return undefined;
  }
  const current = { ...snapshot, primary, secondary };
  observed.set(provider, current);
  return current;
}

export async function failCollectorRunningSlots(
  transport: DaemonConnectionClient,
  agentApiKeys: Map<string, string>,
  agentId: string,
  failureReason: string,
): Promise<void> {
  const agentApiKey = agentApiKeys.get(agentId);
  if (!agentApiKey || !transport.agentWeeklyReportCollect) return;
  await transport.agentWeeklyReportCollect(
    { idempotencyKey: crypto.randomUUID(), failRunningSlots: true, failureReason },
    agentApiKey,
  );
}

export function assertOwnIntent(
  intent: { protocolMajor: number; workspaceId: string; computerId?: string },
  workspaceId: string,
  computerId: string,
): void {
  if (intent.protocolMajor !== 1) throw new Error("unsupported agent protocol major");
  if (intent.workspaceId !== workspaceId) throw new Error("agent intent targets another Workspace");
  if (intent.computerId !== computerId) throw new Error("agent intent targets another Computer");
}
