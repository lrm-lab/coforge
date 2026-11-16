import type {
  AgentReminderOperationRequest,
  AgentReminderOperationResponse,
} from "@lrm/coforge-sdk/internal";
import { ReminderRefusal } from "#src/server/reminders/reminders.server";
import { unsupportedForExternalAgents } from "./external-agent-http.server";

export function externalAgentReminderAnswer(
  command: AgentReminderOperationRequest,
): Response | AgentReminderOperationResponse {
  if (
    command.operation === "schedule" ||
    command.operation === "update" ||
    command.operation === "snooze"
  )
    return unsupportedForExternalAgents(`reminders.${command.operation}`);
  if (command.operation === "cancel") throw new ReminderRefusal("NOT_FOUND", "reminder not found");
  return {
    idempotencyKey: command.idempotencyKey,
    workspaceId: command.workspaceId,
    computerId: command.computerId,
    agentId: command.agentId,
    accepted: true,
    reminders: [],
    events: [],
  };
}
