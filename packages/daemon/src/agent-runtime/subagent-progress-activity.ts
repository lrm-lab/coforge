import type { AgentRuntimeEvent } from "@coforge/agent";
import { subagentTypeLabel } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

type SubagentProgress = Extract<AgentRuntimeEvent, { type: "subagent-progress" }>;

const PHASE_LABEL: Readonly<Record<SubagentProgress["phase"], string>> = {
  started: "Subagent started",
  progress: "Subagent working",
  notification: "Subagent update",
};

/** Default silence threshold before a background task with zero live OS descendants is reaped. */
export const BACKGROUND_TASK_SILENT_MS = 60 * 60_000;

export type OutstandingBackgroundTasksOptions = Readonly<{
  clock?: () => number;
  silentThresholdMs?: number;
  countLiveDescendants?: () => Promise<number | undefined>;
  identity?: Readonly<{ agentId: string; launchId: string }>;
}>;

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
  readonly #tasks = new Map<string, number>();
  readonly #clock: () => number;
  readonly #silentThresholdMs: number;
  readonly #countLiveDescendants: (() => Promise<number | undefined>) | undefined;
  readonly #identity: Readonly<{ agentId: string; launchId: string }> | undefined;

  constructor(options: OutstandingBackgroundTasksOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#silentThresholdMs = options.silentThresholdMs ?? BACKGROUND_TASK_SILENT_MS;
    this.#countLiveDescendants = options.countLiveDescendants;
    this.#identity = options.identity;
  }

  /** Counts a start once per task id, refreshes progress timestamps, and forgets terminal tasks. */
  observe(event: SubagentProgress): void {
    if (!event.taskId) return;
    if (event.taskStatus) {
      this.#tasks.delete(event.taskId);
      return;
    }
    if (event.phase === "started" || (event.phase === "progress" && this.#tasks.has(event.taskId)))
      this.#tasks.set(event.taskId, this.#clock());
  }

  /** How many tasks have started and not yet ended. */
  get count(): number {
    return this.#tasks.size;
  }

  /** Task IDs silent for at least the configured threshold. */
  silentTaskIds(nowMs = this.#clock()): string[] {
    const silent: string[] = [];
    for (const [taskId, lastActivityAtMs] of this.#tasks) {
      if (nowMs - lastActivityAtMs >= this.#silentThresholdMs) silent.push(taskId);
    }
    return silent;
  }

  /**
   * Reaps background tasks silent past the threshold when live OS descendants are proven zero,
   * so a dropped provider terminal notification cannot leave `backgroundTasks > 0` forever.
   */
  async reapZombies(
    countLiveDescendants = this.#countLiveDescendants,
    nowMs = this.#clock(),
  ): Promise<string[]> {
    const candidates = this.silentTaskIds(nowMs);
    if (candidates.length === 0 || !countLiveDescendants) return [];
    const live = await countLiveDescendants().catch(() => undefined);
    if (live !== 0) return [];
    const currentNowMs = this.#clock();
    const reaped: string[] = [];
    for (const taskId of candidates) {
      const lastActivityAtMs = this.#tasks.get(taskId);
      if (
        lastActivityAtMs !== undefined &&
        currentNowMs - lastActivityAtMs >= this.#silentThresholdMs
      ) {
        this.#tasks.delete(taskId);
        reaped.push(taskId);
      }
    }
    if (reaped.length > 0 && this.#identity) {
      logger.warning("Reaped silent zombie background tasks with no live OS descendants", {
        event: "agent_runtime:background_task_reaped",
        agent_id: this.#identity.agentId,
        launch_id: this.#identity.launchId,
        reaped_count: reaped.length,
        remaining_count: this.#tasks.size,
      });
    }
    return reaped;
  }

  /** What a quiet turn shows while tasks are still running, as the reference client words it;
   * `undefined` once none is, when the turn is Idle. */
  quietDetail(): string | undefined {
    const count = this.#tasks.size;
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
