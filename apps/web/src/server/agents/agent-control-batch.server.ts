import type { AgentRuntimeLock } from "./agent-runtime-lock.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { AgentControlAccess } from "./agent-control-access.server";
import type { AgentControlOperations } from "./agent-control-operations.server";
import type { AgentControlPublisher } from "./agent-control-publisher.server";
import {
  CONTROL_MANY_CONCURRENCY,
  type AgentControlAction,
  type AgentControlAgent,
} from "./agent-control-types.server";

/** Stops or starts several Agents for one user at once (a channel's "Stop all" and "Resume all"). */
export class AgentControlBatch {
  constructor(
    private readonly runtimeLock: AgentRuntimeLock,
    private readonly access: AgentControlAccess,
    private readonly operations: AgentControlOperations,
    private readonly publisher: AgentControlPublisher,
    private readonly clock: () => number,
  ) {}

  /**
   * Stops several Agents for one user at once (a channel's "Stop all Agents"): for each Agent the
   * same durable stop `execute({ action: "stop" })` writes. The stop command is sent without
   * waiting for the Daemon: `stoppedAt` keeps the intent, and a Daemon that reconnects still
   * running the Agent is stopped by ready recovery. A command that cannot be sent is tried once
   * more; if it still fails the Agent is reported as not done, and its operation stays "stopping"
   * so a later stop sends it again.
   */
  stopMany(input: { userId: string; workspaceId: string; agentIds: readonly string[] }) {
    const stoppedAt = new Date(this.clock());
    return this.#controlMany(input, "stop", async (agent) => {
      const state = await this.operations.begin(agent, "stop", crypto.randomUUID(), 1, stoppedAt);
      return () => this.publisher.sendStop(state);
    });
  }
  /**
   * Starts several stopped Agents for one user at once (a channel's "Resume all"), each opening
   * its first turn with `resumePrompt` instead of message recovery: the prompt tells it to catch
   * up itself. Clears `stoppedAt` like a user Start. The Start is sent without waiting for the
   * Daemon, and only this once: a Daemon that reconnects before launching gets the same Start
   * from ready recovery, without the prompt, so it is never delivered twice.
   */
  startMany(input: {
    userId: string;
    workspaceId: string;
    agentIds: readonly string[];
    resumePrompt: string;
  }) {
    return this.#controlMany(input, "start", async (agent) => {
      const state = await this.operations.begin(agent, "start", crypto.randomUUID(), 1, null);
      return () =>
        this.publisher.sendStart(agent, state, state.launchId, {
          resumePrompt: input.resumePrompt,
        });
    });
  }
  /**
   * Runs one control operation over many Agents for one user: the role is read once, each Agent
   * is changed under its runtime lock by `change`, and the command it returns is sent after the
   * lock is released, tried twice at most and never waited on. At most `CONTROL_MANY_CONCURRENCY`
   * Agents are in flight, since each holds a runtime-lock connection and a transaction.
   */
  async #controlMany(
    input: { userId: string; workspaceId: string; agentIds: readonly string[] },
    action: AgentControlAction,
    change: (agent: AgentControlAgent) => Promise<() => Promise<unknown>>,
  ): Promise<{ agentId: string; done: boolean }[]> {
    const role = await this.access.actorRole(input.workspaceId, input.userId, action);
    const one = async (agentId: string) => {
      try {
        const send = await this.runtimeLock.run(agentId, async () =>
          change(
            await this.access.controllableAgent(agentId, input.workspaceId, input.userId, role),
          ),
        );
        await send().catch(() => send());
        return { agentId, done: true };
      } catch (error) {
        console.warn(
          JSON.stringify({
            event: "agent_control:control_many_failed",
            action,
            agent_id: agentId,
            workspace_id: input.workspaceId,
            error_type: errorType(error),
          }),
        );
        return { agentId, done: false };
      }
    };
    const results: { agentId: string; done: boolean }[] = [];
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(CONTROL_MANY_CONCURRENCY, input.agentIds.length) },
        async () => {
          while (next < input.agentIds.length) {
            const index = next++;
            results[index] = await one(input.agentIds[index]!);
          }
        },
      ),
    );
    return results;
  }
}
