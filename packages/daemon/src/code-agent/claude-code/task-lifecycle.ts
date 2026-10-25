import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { eventTime, nonEmptyString } from "@lrm/coforge-anvil";
import type { ClaudeSubagentLineage } from "./subagent-lineage";

/** Claude Code's task lifecycle `system` subtypes, by the phase each reports. */
export const TASK_LIFECYCLE_PHASE = new Map<
  unknown,
  Extract<AgentRuntimeEvent, { type: "subagent-progress" }>["phase"]
>([
  ["task_started", "started"],
  ["task_progress", "progress"],
  ["task_notification", "notification"],
]);

export type TaskStatus = NonNullable<
  Extract<AgentRuntimeEvent, { type: "subagent-progress" }>["taskStatus"]
>;

/** Whether a `task_notification`'s status is one of its terminal ones (SDKTaskNotificationMessage). */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "completed" || value === "failed" || value === "stopped";
}

/** The `subagent-progress` event for one task lifecycle report. */
export function taskProgressEvent(
  phase: Extract<AgentRuntimeEvent, { type: "subagent-progress" }>["phase"],
  taskId: string,
  toolUseId: string | undefined,
  subagentType: string | undefined,
  taskStatus?: TaskStatus,
  occurredAt?: string,
): AgentRuntimeEvent {
  return {
    type: "subagent-progress",
    phase,
    taskId,
    ...(taskStatus ? { taskStatus } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(toolUseId ? { parentToolUseId: toolUseId } : {}),
    ...(occurredAt ? { occurredAt } : {}),
  };
}

/**
 * Relays every task's `task_started`/`task_progress`/`task_notification` as
 * `subagent-progress`, whatever its type (a subagent, a background command, a Monitor watch),
 * as the reference client does. Only `task_started` says whether a task is `ambient` (Claude
 * Code's own work, which the SDK keeps out of activity indicators), so the tasks it announced
 * are remembered in `tasks` until a terminal notification, and subagent types with the tool call's
 * lineage.
 */
export function relayTaskLifecycle(
  record: Readonly<Record<string, unknown>>,
  tasks: Map<string, string | undefined>,
  lineage: ClaudeSubagentLineage,
): AgentRuntimeEvent | undefined {
  const phase = TASK_LIFECYCLE_PHASE.get(record.subtype);
  const taskId = typeof record.task_id === "string" ? record.task_id : undefined;
  if (!phase || !taskId) return undefined;
  const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : undefined;
  if (phase === "started") {
    if (record.ambient === true) return undefined;
    tasks.set(taskId, toolUseId);
    lineage.remember(toolUseId, record.subagent_type);
  } else if (!tasks.has(taskId)) return undefined;
  const subagentType = nonEmptyString(record.subagent_type) ?? lineage.typeOf(tasks.get(taskId));
  const taskStatus =
    phase === "notification" && isTaskStatus(record.status) ? record.status : undefined;
  if (taskStatus) tasks.delete(taskId);
  return taskProgressEvent(phase, taskId, toolUseId, subagentType, taskStatus, eventTime(record));
}
