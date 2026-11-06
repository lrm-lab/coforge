import { type AgentRuntimeEvent, type AgentSubagentTaskKind } from "#src/contract";
import { eventTime, nonEmptyString } from "#src/json-record";
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

/** What `relayTaskLifecycle` remembers per live task until its terminal notification. */
export type TrackedTask = Readonly<{
  toolUseId?: string;
  taskKind?: AgentSubagentTaskKind;
}>;

/** Whether a `task_notification`'s status is one of its terminal ones (SDKTaskNotificationMessage). */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "completed" || value === "failed" || value === "stopped";
}

/**
 * Raft's `taskKindFromType`: which lifecycle kind a Claude `task_type` names. `local_bash` is a
 * background command, anything naming an agent or teammate is a delegated subagent, and every
 * other type (a Monitor watch, a workflow) is `other`. An absent `task_type` stays unclassified
 * so the daemon falls back to showing the row.
 */
export function taskKindFromType(taskType: unknown): AgentSubagentTaskKind | undefined {
  if (typeof taskType !== "string" || taskType.length === 0) return undefined;
  if (taskType === "local_bash") return "command";
  if (/agent|teammate/.test(taskType)) return "agent";
  return "other";
}

/** The `subagent-progress` event for one task lifecycle report. */
export function taskProgressEvent(input: {
  phase: Extract<AgentRuntimeEvent, { type: "subagent-progress" }>["phase"];
  taskId: string;
  toolUseId?: string;
  subagentType?: string;
  taskKind?: AgentSubagentTaskKind;
  taskStatus?: TaskStatus;
  occurredAt?: string;
}): AgentRuntimeEvent {
  return {
    type: "subagent-progress",
    phase: input.phase,
    taskId: input.taskId,
    ...(input.taskStatus ? { taskStatus: input.taskStatus } : {}),
    ...(input.taskKind ? { taskKind: input.taskKind } : {}),
    ...(input.subagentType ? { subagentType: input.subagentType } : {}),
    ...(input.toolUseId ? { parentToolUseId: input.toolUseId } : {}),
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };
}

/**
 * Relays every task's `task_started`/`task_progress`/`task_notification` as
 * `subagent-progress`, whatever its type (a subagent, a background command, a Monitor watch),
 * as the reference client does. Only `task_started` says whether a task is `ambient` (Claude
 * Code's own work, which the SDK keeps out of activity indicators), so the tasks it announced
 * are remembered in `tasks` until a terminal notification, and subagent types with the tool call's
 * lineage. `task_type` appears on `task_started` but later phases may omit it, so the kind is
 * remembered per task the same way.
 */
export function relayTaskLifecycle(
  record: Readonly<Record<string, unknown>>,
  tasks: Map<string, TrackedTask>,
  lineage: ClaudeSubagentLineage,
): AgentRuntimeEvent | undefined {
  const phase = TASK_LIFECYCLE_PHASE.get(record.subtype);
  const taskId = typeof record.task_id === "string" ? record.task_id : undefined;
  if (!phase || !taskId) return undefined;
  const toolUseId = typeof record.tool_use_id === "string" ? record.tool_use_id : undefined;
  const reportedKind = taskKindFromType(record.task_type);
  let taskKind: AgentSubagentTaskKind | undefined;
  let lineageToolUseId: string | undefined;
  if (phase === "started") {
    if (record.ambient === true) return undefined;
    taskKind = reportedKind;
    tasks.set(taskId, { toolUseId, taskKind });
    lineage.remember(toolUseId, record.subagent_type);
    lineageToolUseId = toolUseId;
  } else {
    const remembered = tasks.get(taskId);
    if (!remembered) return undefined;
    taskKind = reportedKind ?? remembered.taskKind;
    lineageToolUseId = remembered.toolUseId;
  }
  const subagentType = nonEmptyString(record.subagent_type) ?? lineage.typeOf(lineageToolUseId);
  const taskStatus =
    phase === "notification" && isTaskStatus(record.status) ? record.status : undefined;
  if (taskStatus) tasks.delete(taskId);
  return taskProgressEvent({
    phase,
    taskId,
    toolUseId,
    subagentType,
    taskKind,
    taskStatus,
    occurredAt: eventTime(record),
  });
}
