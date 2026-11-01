import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

export async function failCollectorRunningSlots(
  transport: DaemonConnectionClient,
  agentApiKeys: Map<string, string>,
  agentId: string,
  failureReason: string,
): Promise<void> {
  // A collector turn that dies before HTTPS submit (e.g. model 405) must
  // still settle Collect Run slots — Activity alone is not a completion boundary.
  const agentApiKey = agentApiKeys.get(agentId);
  if (!agentApiKey || !transport.agentWeeklyReportCollect) return;
  await transport.agentWeeklyReportCollect(
    { idempotencyKey: crypto.randomUUID(), failRunningSlots: true, failureReason },
    agentApiKey,
  );
}
