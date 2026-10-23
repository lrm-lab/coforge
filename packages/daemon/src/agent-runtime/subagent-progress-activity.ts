import type { AgentRuntimeEvent } from "@coforge/agent";
import { subagentTypeLabel } from "#src/code-agent/subagent-type";

type SubagentProgress = Extract<AgentRuntimeEvent, { type: "subagent-progress" }>;

const PHASE_LABEL: Readonly<Record<SubagentProgress["phase"], string>> = {
  started: "Subagent started",
  progress: "Subagent working",
  notification: "Subagent update",
};

/**
 * A subagent progress row's text, as the reference client words it: the phase (a notification
 * by its terminal status), then the provider's subagent type in parentheses. The type is the
 * only provider field it shows (never a task description or summary, which can carry prompt
 * text), single-line and capped.
 */
export function subagentProgressDetail(event: SubagentProgress): string {
  const type = subagentTypeLabel(event.subagentType);
  const label =
    event.phase === "notification" && event.taskStatus
      ? `Subagent ${event.taskStatus}`
      : PHASE_LABEL[event.phase];
  return type ? `${label} (${type})` : label;
}

/**
 * One launch's tasks (subagents, background commands, watches) that have started and not yet
 * reported a terminal notification, by the provider's task id, and what a turn that ends while
 * they run shows. They outlive the turn that started them, so a new turn never clears them; a
 * new launch starts with none. A report without a task id is never counted.
 */
export class OutstandingBackgroundTasks {
  readonly #taskIds = new Set<string>();

  /** Counts a start once per task id and forgets a task at its terminal notification. */
  observe(event: SubagentProgress): void {
    if (!event.taskId) return;
    if (event.phase === "started") this.#taskIds.add(event.taskId);
    else if (event.taskStatus) this.#taskIds.delete(event.taskId);
  }

  /** How many tasks have started and not yet ended. */
  get count(): number {
    return this.#taskIds.size;
  }

  /** What a quiet turn shows while tasks are still running, as the reference client words it;
   * `undefined` once none is, when the turn is Idle. */
  quietDetail(): string | undefined {
    const count = this.#taskIds.size;
    return count > 0 ? `Waiting for ${count} background task${count === 1 ? "" : "s"}` : undefined;
  }
}
