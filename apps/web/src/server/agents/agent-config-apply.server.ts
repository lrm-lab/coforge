import { encodeAgentConfigSync, type AgentConfigSync } from "@lrm/coforge-sdk/internal";
import {
  daemonControlChannel,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { errorType } from "#src/server/errors/error-type.server";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";
import { getAgentConfigCapabilityLease } from "./agent-config-capability.server";
import {
  ControlFenceLostError,
  planAgentConfig,
  type AgentConfigChange,
  type AgentConfigDecision,
  type AgentConfigPlan,
  type ControlFence,
} from "./agent-config-plan.server";
import type { AgentSessionRepository } from "./agent-sessions.server";
import {
  current,
  type AgentControlAgent,
  type AgentControlStore,
} from "./agent-control-types.server";
import { requiredRuntimeConfig, runtimeStartFields } from "./agent-runtime-config.server";

/** What a saved runtime configuration did about a running Agent: `published` is a new Start after
 * a Stop, `when-idle` a pushed configuration the Daemon applies at its next idle, `deferred` a
 * configuration that waits for the Agent's next Start, `not-required` a save that changed nothing
 * the runtime reads. */
export type AgentRestartOutcome = "published" | "deferred" | "when-idle" | "not-required";

/** Which Computers take a pushed configuration, and the way to send one. */
export type AgentConfigPush = {
  supports(workspaceId: string, computerId: string): Promise<boolean>;
  publish(sync: AgentConfigSync): Promise<void>;
};

/** The production push: the Computer's capability lease, and the Daemon's control channel. */
export function createAgentConfigPush(api: Pick<CentrifugoServerApi, "publish">): AgentConfigPush {
  return {
    supports: (workspaceId, computerId) =>
      getAgentConfigCapabilityLease().supports(workspaceId, computerId),
    publish: (sync) =>
      api.publish(
        daemonControlChannel(sync.workspaceId, sync.computerId),
        encodeAgentConfigSync(sync),
      ),
  };
}

/** What a runtime-config write returns: the configuration and revision as the row now holds them. */
export type UpdatedRuntimeConfig = Pick<AgentRecord, "runtimeConfig" | "runtimeConfigRevision">;

type PushedAgent = Pick<
  AgentRecord,
  "id" | "workspaceId" | "computerId" | "runtimeConfig" | "runtimeConfigRevision"
>;

/** Sends `agent`'s configuration (with the revision it carries) to its Daemon. */
export async function publishAgentConfig(push: AgentConfigPush, agent: PushedAgent) {
  if (!agent.computerId) throw new Error("Agent has no Computer");
  await push.publish({
    protocolMajor: 1,
    workspaceId: agent.workspaceId,
    computerId: agent.computerId,
    agentId: agent.id,
    revision: agent.runtimeConfigRevision ?? 0,
    ...runtimeStartFields(requiredRuntimeConfig(agent)),
  });
}

/** `tryPush`: the plan when nothing was written (the caller persists and restarts as that plan
 * says), or the push that was written and what became of its publication. */
export type PushAttempt<W> =
  | { plan: Exclude<AgentConfigPlan, "push"> }
  | { plan: "push"; written: W; restart: "when-idle" | "deferred" };

/**
 * Decides how a saved runtime configuration (selection or environment) reaches
 * an Agent, and runs the push when it is the way. A running Agent on a Daemon that advertised
 * `agent-config:v1` keeps its process: the save persists, bumping `runtimeConfigRevision`, and
 * the Daemon applies the pushed configuration at its next idle. Built without a push, it always
 * plans the caller's own Stop, persist, Start path.
 */
export class AgentConfigApply {
  constructor(
    private readonly push?: AgentConfigPush,
    /** Reads the latest control operation; without it nothing proves the Agent is running. */
    private readonly control?: Pick<AgentControlStore, "get">,
    /** The Session repository's read, whose `memoryAgent` is the one fact a Start also sends. */
    private readonly sessions?: Pick<AgentSessionRepository, "read">,
  ) {}

  async plan(
    agent: Pick<AgentRecord, "id" | "workspaceId" | "computerId" | "stoppedAt">,
    change: AgentConfigChange,
  ): Promise<AgentConfigDecision> {
    // Only a running Agent that changes and keeps its Computer and provider can be pushed to. The
    // capability (one Redis read) goes first; the control state and the Session are read only for
    // a Daemon that takes the push.
    if (
      !this.push ||
      !change.changed ||
      change.computerChanged === true ||
      change.providerChanged === true ||
      agent.stoppedAt ||
      !agent.computerId ||
      !(await this.push.supports(agent.workspaceId, agent.computerId).catch(() => false))
    )
      return planAgentConfig(agent, change);
    const [control, session] = await Promise.all([
      this.control?.get(agent.id),
      // A Session that cannot be read cannot say, so it does not push either.
      this.sessions?.read(agent.id).catch(() => ({ memoryAgent: true })),
    ]);
    return planAgentConfig(agent, change, runningFence(control, session?.memoryAgent === true));
  }

  /**
   * Plans, and when the plan is a push, runs `write` under the plan's fence and publishes what it
   * returns. A control state that moved since the plan makes `write` throw `ControlFenceLostError`
   * with nothing written, and the plan falls back to `restart`. The configuration is saved before
   * it is published, so a failed publish only defers it to the Agent's next Start (ready sends it
   * again). Any other error from `write` is the caller's.
   */
  async tryPush<W extends UpdatedRuntimeConfig>(
    agent: Pick<AgentRecord, "id" | "workspaceId" | "computerId" | "stoppedAt">,
    change: AgentConfigChange,
    write: (fence: ControlFence) => Promise<W>,
  ): Promise<PushAttempt<W>> {
    const decision = await this.plan(agent, change);
    if (decision.plan !== "push") return { plan: decision.plan };
    const { fence } = decision;
    if (!fence || !this.push) return { plan: "restart" };
    let written: W;
    try {
      written = await write(fence);
    } catch (error) {
      if (error instanceof ControlFenceLostError) return { plan: "restart" };
      throw error;
    }
    try {
      await publishAgentConfig(this.push, { ...agent, ...written });
      return { plan: "push", written, restart: "when-idle" };
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_config:push_failed",
          agent_id: agent.id,
          workspace_id: agent.workspaceId,
          computer_id: agent.computerId,
          config_revision: written.runtimeConfigRevision ?? 0,
          error_type: errorType(error),
        }),
      );
      return { plan: "push", written, restart: "deferred" };
    }
  }
}

/** The control state when the Agent's latest operation completed a Start under the current
 * configuration: the one state a push may re-fence. A stop, an in-flight or failed operation, a
 * stale scope or a Workspace Memory Agent (the Daemon's idle rule never stops one, so a push would
 * stay pending) is none of these. */
function runningFence(
  agent: AgentControlAgent | undefined,
  memoryAgent: boolean,
): ControlFence | undefined {
  const state = agent?.state;
  if (!agent || !state || state.phase !== "completed" || state.action === "stop") return;
  if (!current(agent, state) || memoryAgent) return;
  return { controlState: agent.storedControlState };
}
