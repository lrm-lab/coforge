import type { AgentNoticeOptions, AgentSession, AgentSessionOptions } from "@coforge/agent";
import type { TaskExecutionScope } from "@lrm/coforge-sdk/internal";
import { ScopedAgentSessions, type ConversationSessionStore } from "./scoped-agent-sessions";
import { getLogger } from "@logtape/logtape";

export interface TaskSessionBindings {
  read(controlSessionId: string): Promise<TaskExecutionScope[]>;
  write(controlSessionId: string, tasks: TaskExecutionScope[]): Promise<void>;
}
type Dependencies = {
  primary: AgentSession;
  options: AgentSessionOptions;
  create(options: AgentSessionOptions): Promise<AgentSession>;
  store?: ConversationSessionStore;
  bindings: TaskSessionBindings;
  report(
    task: TaskExecutionScope,
    status: "starting" | "running" | "waiting" | "failed",
    nativeSessionId?: string,
  ): Promise<void>;
};

/** Task histories share the Agent identity and take turns using its workspace. */
export class TaskExecutionSessions extends ScopedAgentSessions {
  readonly #tasks: Map<string, TaskExecutionScope>;
  readonly #pending = new Map<string, Promise<void>>();
  readonly #attached: Set<string>;
  readonly #ended = new Set<string>();
  #writes: Promise<void> = Promise.resolve();
  #handoffs: Promise<unknown> = Promise.resolve();
  #handoffBoundary = false;
  #closing = false;
  readonly #openTools = new Set<string>();
  readonly #background = new Set<string>();

  static async open(dependencies: Dependencies): Promise<TaskExecutionSessions> {
    const controlId =
      (await dependencies.primary.readSessionIdentity?.())?.sessionId ??
      dependencies.options.sessionId;
    if (!controlId) throw new Error("Task execution requires a standing session identity");
    return new TaskExecutionSessions(
      dependencies,
      controlId,
      await dependencies.bindings.read(controlId),
    );
  }

  private constructor(
    private readonly taskDependencies: Dependencies,
    private readonly controlId: string,
    tasks: TaskExecutionScope[],
  ) {
    const byTask = new Map(tasks.map((task) => [taskKey(task), task]));
    const attached = new Set<string>();
    super({
      ...taskDependencies,
      scope: (options?: AgentNoticeOptions) => {
        const task = options?.conversation
          ? byTask.get(targetKey(options.conversation))
          : undefined;
        if (task && options?.conversation) task.target = options.conversation.target;
        return task
          ? {
              conversationId: task.conversationId,
              target: task.target,
              key: `${task.executionSessionId}:${task.attempt}`,
              instructions: taskInstructions(taskDependencies.options.instructions, task),
            }
          : undefined;
      },
      onIdentity: async (scope, identity) => {
        const task = byTask.get(targetKey(scope))!;
        await taskDependencies.report(task, "starting", identity.sessionId);
        attached.add(`${task.executionSessionId}:${task.attempt}`);
      },
    });
    this.#tasks = byTask;
    this.#attached = attached;
    this.subscribe((event) => {
      if (!event.conversation) {
        if (event.type === "tool-start") this.#openTools.add(event.id);
        if (event.type === "tool-end") this.#openTools.delete(event.id);
        if (event.type === "subagent-progress" && event.taskId) {
          if (event.taskStatus) this.#background.delete(event.taskId);
          else this.#background.add(event.taskId);
        }
        if (event.type === "completed") {
          this.#handoffBoundary = false;
          this.#openTools.clear();
        }
        if (
          this.#handoffBoundary &&
          !this.#openTools.size &&
          !this.#background.size &&
          (event.type === "tool-end" || event.type === "subagent-progress")
        ) {
          this.#handoffBoundary = false;
          void taskDependencies.primary
            .interrupt()
            .catch(() =>
              getLogger(["coforge", "daemon", "task-sessions"]).warn(
                "Standing turn handoff interrupt failed",
                { event: "task_session:handoff_interrupt_failed" },
              ),
            );
        }
      }
      const task = event.conversation ? byTask.get(targetKey(event.conversation)) : undefined;
      if (task && event.type === "completed")
        void taskDependencies
          .report(task, event.status === "failed" ? "failed" : "waiting")
          .catch(() =>
            getLogger(["coforge", "daemon", "task-sessions"]).warn(
              "Task execution completion report could not be recorded",
              { event: "task_session:completion_report_failed" },
            ),
          );
    });
  }

  override hasLiveTurnForConversation(conversationId: string): boolean | undefined {
    if (super.hasLiveTurnForConversation(conversationId)) return true;
    return this.taskDependencies.primary.hasLiveTurn;
  }

  async handoffTask(task: TaskExecutionScope): Promise<boolean> {
    const handoff = this.#handoffs.then(() => this.#handoff(task));
    this.#handoffs = handoff.catch(() => {});
    return handoff;
  }

  async #handoff(task: TaskExecutionScope): Promise<boolean> {
    const current = this.#tasks.get(taskKey(task));
    const key = `${task.executionSessionId}:${task.attempt}`;
    if (this.#ended.has(key) || this.scopeIsWorking(key)) return false;
    if (
      current?.executionSessionId === task.executionSessionId &&
      current.attempt === task.attempt &&
      (this.#pending.has(key) || (this.#attached.has(key) && current.requestId === task.requestId))
    )
      return true;
    if (
      current &&
      (current.executionSessionId !== task.executionSessionId || current.attempt !== task.attempt)
    ) {
      const previous = `${current.executionSessionId}:${current.attempt}`;
      this.#ended.add(previous);
      await this.purgeScope(previous);
    }
    this.#tasks.set(taskKey(task), task);
    const write = this.#writes.then(() =>
      this.taskDependencies.bindings.write(this.controlId, [...this.#tasks.values()]),
    );
    this.#writes = write.catch(() => {});
    try {
      await write;
    } catch (error) {
      if (current) this.#tasks.set(taskKey(task), current);
      else this.#tasks.delete(taskKey(task));
      throw error;
    }
    if (this.#ended.has(key)) return false;
    if (this.primaryIsWorking) this.#handoffBoundary = true;
    const run = this.notify(
      `Work on task #${task.number} in ${task.target}. The task is already claimed by you. Read the original task message and any existing task checkpoint in notes/tasks/ first. Follow the task brief; deliver evidence and update its status. Do not repeat an external action whose receipt already exists.`,
      {
        conversation: { conversationId: task.conversationId, target: task.target },
      },
    )
      .then(
        () => this.taskDependencies.report(task, "running"),
        () => this.taskDependencies.report(task, this.#closing ? "waiting" : "failed"),
      )
      .catch(() =>
        getLogger(["coforge", "daemon", "task-sessions"]).warn(
          "Task execution report could not be recorded",
          { event: "task_session:report_failed" },
        ),
      )
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, run);
    return true;
  }

  endTask(executionSessionId: string, attempt: number): Promise<void> {
    this.#ended.add(`${executionSessionId}:${attempt}`);
    const end = this.#handoffs.then(() => this.#endTask(executionSessionId, attempt));
    this.#handoffs = end.catch(() => {});
    return end;
  }

  async #endTask(executionSessionId: string, attempt: number): Promise<void> {
    const task = [...this.#tasks.values()].find(
      (value) => value.executionSessionId === executionSessionId && value.attempt === attempt,
    );
    if (!task) return;
    await this.purgeScope(`${executionSessionId}:${attempt}`);
    this.#tasks.delete(taskKey(task));
    this.#attached.delete(`${executionSessionId}:${attempt}`);
    const write = this.#writes.then(() =>
      this.taskDependencies.bindings.write(this.controlId, [...this.#tasks.values()]),
    );
    this.#writes = write.catch(() => {});
    await write;
  }

  override cancelPendingNotices(): void {
    this.#closing = true;
    super.cancelPendingNotices();
  }

  override async dispose(options?: Readonly<{ cutoffAtMs?: number }>): Promise<void> {
    await super.dispose(options);
    await this.#handoffs;
    await this.#writes;
    await Promise.allSettled(this.#pending.values());
  }
}

function taskInstructions(base: string, task: TaskExecutionScope): string {
  return `${base}\n\n## Isolated task execution\nThis session works only on task #${task.number} at ${task.target}, revision ${task.revision}. You retain your Agent identity and permissions. Read only referenced evidence needed for this task; do not recover other tasks, scan the channel or load the standing session's active-context notes. Use the exact task thread for messages. Do not poll messages or post acknowledgements. If you are this channel's coordinator, delegate executable subtasks through assigned Tasks when your permissions allow it; otherwise create a Task and directly ask the selected Agent to claim it. End after dispatch. Summarize when findings change the next step, not on routine progress. Keep recovery facts, external job IDs, receipts and the next action in notes/tasks/${task.messageId}.md. Keep routine progress in task artifacts; send a concise result with evidence, a blocker, or a decision request. End your turn while waiting for external work; an event or the existing authorized reminder will wake you. Never create a replacement job merely because this is a new native session.\n\nTask title:\n${task.title}\n\nTask description:\n${task.description ?? "See the original task message for acceptance criteria."}\n`;
}

function taskKey(task: TaskExecutionScope): string {
  return `${task.conversationId}:${task.messageId}`;
}

function targetKey(scope: { conversationId: string; target: string }): string {
  return `${scope.conversationId}:${scope.target.split(":")[1] ?? ""}`;
}
