import type { ReminderFireResponse, ReminderSync } from "@lrm/coforge-sdk/internal";
import type { ReminderReceipt } from "./reminder-receipt";

export function assertCorrelated(receipt: ReminderReceipt, response: ReminderFireResponse): void {
  for (const field of ["requestId", "workspaceId", "computerId", "agentId", "reminderId"] as const)
    if (response[field] !== receipt[field]) throw new Error("uncorrelated reminder fire response");
  if (response.protocolMajor !== 1 || response.version !== receipt.version)
    throw new Error("uncorrelated reminder fire response");
}

export function assertSyncScope(
  scope: { workspaceId: string; computerId: string },
  sync: ReminderSync,
): void {
  if (
    sync.protocolMajor !== 1 ||
    sync.workspaceId !== scope.workspaceId ||
    sync.computerId !== scope.computerId ||
    sync.jobs.some((j) => j.ownerAgentId !== sync.agentId)
  )
    throw new Error("reminder sync targets another daemon");
}
