import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { ReminderDueReceiver } from "#src/agent-reminder/reminder-due-receiver";
import type { AgentInboxCoordinator } from "./agent-inbox-coordinator";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import type {
  AgentReminderOperationRequest,
  LocalReminderRequest,
  ReminderJob,
  TaskCommand,
  TaskResult,
} from "@lrm/coforge-sdk/internal";
import type { MintAppItem } from "#src/agent-app-inbox/agent-app-inbox";
import { taskWriteWithFreshness } from "./task-write-freshness";
import { reminderDueItemId } from "#src/agent-app-inbox/registry";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import {
  reminderAppInboxPreview,
  reminderAppInboxSummary,
} from "#src/agent-reminder/reminder-app-inbox-text";
import { getLogger } from "@logtape/logtape";
import { sealReminder, sealedReminderConflict } from "./runtime-agent-api-reminder-seals";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type RuntimeAgentApiRemindersPorts = {
  assertRunning(): void;
  agentIdForContext(context: string): string;
  transport: () => DaemonConnectionClient;
  workspaceId: string;
  computerId: string;
  messageAttention: AgentMessageAttentionIndex;
  reminders: ReminderDueReceiver;
  inboxCoordinator: AgentInboxCoordinator;
};

const TASK_WRITE_OPERATIONS = new Set([
  "create",
  "claim",
  "assign",
  "unclaim",
  "update",
  "amend",
  "delete",
]);

/** Dispatches one task command to the cloud task route over its HTTPS path. The body is the
 * plain command — the route derives its principal from the Agent API key, so no envelope travels. */
export async function agentTask(
  ports: RuntimeAgentApiRemindersPorts,
  context: string,
  command: TaskCommand,
  agentApiKey: string,
): Promise<TaskResult> {
  ports.assertRunning();
  const agentId = ports.agentIdForContext(context);
  const transport = ports.transport();
  if (!transport.agentTask) throw new Error("daemon connection is not connected");
  if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
  const isWrite = TASK_WRITE_OPERATIONS.has(command.operation);
  if (command.target) {
    const result = await taskWriteWithFreshness(
      {
        messageAttention: ports.messageAttention,
        agentTask: transport.agentTask.bind(transport),
      },
      agentId,
      command,
      command.target,
      agentApiKey,
    );
    if (result) {
      if (isWrite) ports.inboxCoordinator.noteCoforgeWriteOrHold(agentId);
      return result;
    }
  }
  const result = await transport.agentTask({ ...command }, agentApiKey);
  if (isWrite) ports.inboxCoordinator.noteCoforgeWriteOrHold(agentId);
  return result;
}

export async function mintAppItem(
  ports: RuntimeAgentApiRemindersPorts,
  agentId: string,
  input: MintAppItem,
) {
  return ports.inboxCoordinator.mintAppItem(agentId, input);
}

export async function reminder(
  ports: RuntimeAgentApiRemindersPorts,
  context: string,
  request: LocalReminderRequest,
  agentApiKey: string,
) {
  const agentId = ports.agentIdForContext(context);
  if (!isAgentApiKey(agentApiKey)) throw new Error("Agent API key is missing");
  if (request.operation === "seal" || request.operation === "unseal")
    return sealReminder(ports, agentId, request);
  if (
    request.reminderId &&
    (request.operation === "cancel" ||
      request.operation === "snooze" ||
      request.operation === "update" ||
      request.operation === "ack" ||
      request.operation === "dismiss")
  ) {
    const sealed = await sealedReminderConflict(ports, agentId, request.reminderId);
    if (sealed) return sealed;
  }
  if (request.operation === "ack" || request.operation === "dismiss") {
    const accepted = await ports.reminders.acknowledge(
      agentId,
      request.reminderId!,
      request.revision!,
      request.operation,
    );
    const removed = await ports.inboxCoordinator.removeAppItem(
      agentId,
      reminderDueItemId(request.reminderId!, request.revision!),
    );
    if (!accepted) {
      // Neither the receipt file nor this daemon knows the receipt (the file was lost or is
      // unreadable, and the daemon has restarted since), but the Agent was shown this exact
      // revision: its inbox item proves the delivery. Clear it rather than leave an item nothing
      // can ever acknowledge; the cloud already refuses to fire this revision again.
      if (!removed)
        return { accepted: false, reason: "reminder receipt not found for exact revision" };
      logger.info("Reminder acknowledged from its inbox item without a local receipt", {
        event: "reminder.ack_without_receipt",
        outcome: "ok",
        agent_id: agentId,
        reminder_id: request.reminderId,
        reminder_version: request.revision,
      });
    }
    return { accepted: true, reminderId: request.reminderId, revision: request.revision };
  }
  const transport = ports.transport();
  if (!transport.agentReminder) throw new Error("Agent reminder transport is unavailable");
  const { context: _context, revision: _revision, ...fields } = request;
  return transport.agentReminder(
    {
      ...fields,
      workspaceId: ports.workspaceId,
      computerId: ports.computerId,
      agentId,
    } as AgentReminderOperationRequest,
    agentApiKey,
  );
}

export async function deliverReminderDue(
  ports: RuntimeAgentApiRemindersPorts,
  job: ReminderJob,
  late: boolean,
): Promise<string> {
  const item = await (
    await ports.inboxCoordinator.appInbox(job.ownerAgentId)
  ).upsert({
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
    title: reminderAppInboxPreview(job.title),
    summary: reminderAppInboxSummary(job, late),
  });
  return item.itemId;
}

export async function wakeReminderDue(
  ports: RuntimeAgentApiRemindersPorts,
  agentId: string,
  itemId: string,
): Promise<boolean> {
  const coordinator = ports.inboxCoordinator;
  const items = (await coordinator.appInbox(agentId)).list();
  if (!items.some((item) => item.itemId === itemId)) return true;
  if (!coordinator.wakeable(agentId)) return true;
  return coordinator.notifyAppItem(agentId, itemId).catch((error: unknown) => {
    logger.warn("Reminder item was kept but its notice was not written", {
      event: "reminder.due_notice_failed",
      agent_id: agentId,
      item_id: itemId,
      error,
    });
    return false;
  });
}
