import type { AgentRuntimeEvent } from "#src/code-agent/contract";

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
