import type { AgentSession } from "@coforge/agent";
import type {
  TaskCommand,
  TaskResult,
  TaskExecutionScope,
  AgentMessageDelivery,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { FileTaskSessionBindings } from "#src/persistence/task-session-bindings";
import { escapePathIdentity } from "#src/persistence/path-scope";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
import { heldTaskResult } from "./held-task-result";

type Ports = {
  stateDirectory: string;
  workspaceId: string;
  attention: AgentMessageAttentionIndex;
  readonly transport: Pick<DaemonConnectionClient, "agentTask" | "agentMessage">;
  session(agentId: string): AgentSession | undefined;
  apiKey(agentId: string): string | undefined;
  authorizedAgent(context: string, key: string): string;
  acknowledge(message: AgentMessageDelivery): Promise<void>;
};

/** Task command freshness, native handoff and fenced execution observations. */
export class AgentTaskOperations {
  readonly #bindings = new Map<string, FileTaskSessionBindings>();
  constructor(private readonly ports: Ports) {}

  async signal(message: AgentMessageDelivery): Promise<void> {
    const signal = message.taskExecutionSignal;
    if (signal?.kind !== "ended") throw new Error("Expected a terminal task execution signal");
    if (message.latestSenderKind !== "system")
      throw new Error("Task execution control requires a server-authored delivery");
    const session = this.ports.session(message.agentId);
    if (session?.endTask) await session.endTask(signal.executionSessionId, signal.attempt);
    await this.sessionConfiguration(message.agentId).bindings.end(
      signal.executionSessionId,
      signal.attempt,
    );
    await this.ports.acknowledge(message);
  }

  sessionConfiguration(agentId: string) {
    let bindings = this.#bindings.get(agentId);
    if (!bindings) {
      bindings = new FileTaskSessionBindings(
        `${this.ports.stateDirectory}/task-sessions/${escapePathIdentity(this.ports.workspaceId)}/${escapePathIdentity(agentId)}.json`,
      );
      this.#bindings.set(agentId, bindings);
    }
    return {
      bindings,
      report: async (
        task: TaskExecutionScope,
        status: "starting" | "running" | "waiting" | "failed",
        nativeSessionId?: string,
      ) => {
        const key = this.ports.apiKey(agentId);
        if (!key || !this.ports.transport.agentTask)
          throw new Error("Task execution transport is unavailable");
        await this.ports.transport.agentTask(
          {
            operation: "execution",
            idempotencyKey: crypto.randomUUID(),
            conversationId: task.conversationId,
            number: task.number,
            executionReport: {
              id: task.executionSessionId,
              attempt: task.attempt,
              status,
              ...(nativeSessionId ? { nativeSessionId } : {}),
            },
          },
          key,
        );
      },
    };
  }

  /** The HTTPS body is the plain command; the server derives authority from the Agent API key. */
  async handle(context: string, command: TaskCommand, agentApiKey: string): Promise<TaskResult> {
    const agentId = this.ports.authorizedAgent(context, agentApiKey);
    const transport = this.ports.transport;
    if (!transport.agentTask) throw new Error("daemon connection is not connected");
    if (["claim", "update"].includes(command.operation) && command.target) {
      const held = await heldTaskResult(
        {
          messageAttention: this.ports.attention,
          agentMessage: transport.agentMessage?.bind(transport),
          workspaceId: this.ports.workspaceId,
        },
        agentId,
        command,
        command.target,
        agentApiKey,
      );
      if (held) return held;
    }
    const session = this.ports.session(agentId);
    const capable = Boolean(session?.handoffTask);
    const result = await transport.agentTask(
      {
        ...command,
        ...(["claim", "create"].includes(command.operation) && capable
          ? { isolatedExecution: true }
          : {}),
      },
      agentApiKey,
    );
    if (capable && ["claim", "create"].includes(command.operation) && command.target) {
      const handoffs: TaskExecutionScope[] = [];
      for (const task of result.tasks) {
        if (!task.execution || task.owner?.id !== agentId) continue;
        const scope = {
          requestId: command.idempotencyKey,
          executionSessionId: task.execution.id,
          attempt: task.execution.attempt,
          conversationId: task.conversationId,
          messageId: task.messageId,
          number: task.number,
          title: task.title,
          description: task.description,
          revision: task.revision,
          target: `${command.target}:${task.messageId}`,
        };
        if ((await session!.handoffTask!(scope)) !== false) handoffs.push(scope);
      }
      if (handoffs.length) return { ...result, executionHandoffs: handoffs };
    }
    return result;
  }
}
