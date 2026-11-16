import type { ReminderAcknowledgementSyncRequest } from "#src/agent-reminder/reminder-acknowledgement-sync";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";

export async function sendReminderAcknowledgement(
  request: ReminderAcknowledgementSyncRequest,
  agentApiKeys: ReadonlyMap<string, string>,
  transport: DaemonConnectionClient,
  workspaceId: string,
  computerId: string,
): Promise<void> {
  const agentApiKey = agentApiKeys.get(request.agentId);
  if (!agentApiKey) throw new Error("Agent API key is missing");
  if (!transport.agentReminder) throw new Error("Agent reminder transport is unavailable");
  const response = await transport.agentReminder(
    {
      workspaceId,
      computerId,
      agentId: request.agentId,
      operation: request.operation,
      reminderId: request.reminderId,
      revision: request.version,
      idempotencyKey: request.idempotencyKey,
    },
    agentApiKey,
  );
  if (!response.accepted)
    throw new Error(response.reason ?? "reminder acknowledgement was not accepted");
}
