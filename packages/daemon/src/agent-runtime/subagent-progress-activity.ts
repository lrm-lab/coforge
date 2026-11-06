import type { AgentRuntimeEvent } from "@coforge/agent";
import { subagentTypeLabel } from "@lrm/coforge-anvil";

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

/**
 * One launch's subagent-wake bookkeeping (Raft's `subagentResultUnread` /
 * `userStoppedSubagents`): a task that ended while the turn was quiet leaves a result the
 * session never saw, so when the last task ends the daemon writes a wake notice; a task the
 * user stopped through a per-subagent interrupt is not an unread result.
 */
export class SubagentWakeTracker {
  /** A terminal notification arrived while quiet and its result is still untold. */
  resultUnread = false;
  readonly #userStopped = new Set<string>();

  /** The daemon interrupted this task itself; its ending is the user's doing, not news. */
  noteUserStop(taskId: string): void {
    this.#userStopped.add(taskId);
  }

  /**
   * Reads one terminal task notification: forgets a remembered user stop and says whether the
   * ending was the user's own stop. Only a `"stopped"` status counts — a task that finished
   * anyway still carries an untold result.
   */
  noteTerminal(taskId: string, taskStatus: string): boolean {
    const userStopped = this.#userStopped.delete(taskId) && taskStatus === "stopped";
    if (!userStopped) this.resultUnread = true;
    return userStopped;
  }

  /** The last task ended with an untold result: take the one wake this launch earns. */
  takeWake(): boolean {
    if (!this.resultUnread) return false;
    this.resultUnread = false;
    return true;
  }
}
