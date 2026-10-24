import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";

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
