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
import {
  current,
  type AgentControlAgent,
  type AgentControlStore,
} from "./agent-control-types.server";
import { requiredRuntimeConfig, runtimeStartFields } from "./agent-runtime-config.server";
export type AgentRestartOutcome = "published" | "deferred" | "when-idle" | "not-required";
export type AgentConfigPush = {
  supports(workspaceId: string, computerId: string): Promise<boolean>;
  publish(sync: AgentConfigSync): Promise<void>;
};
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
export type UpdatedRuntimeConfig = Pick<AgentRecord, "runtimeConfig" | "runtimeConfigRevision">;
type PushedAgent = Pick<
  AgentRecord,
  "id" | "workspaceId" | "computerId" | "runtimeConfig" | "runtimeConfigRevision"
>;
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
export type PushAttempt<W> =
  | {
      plan: Exclude<AgentConfigPlan, "push">;
    }
  | {
      plan: "push";
      written: W;
      restart: "when-idle" | "deferred";
    };
export class AgentConfigApply {
  constructor(
    private readonly push?: AgentConfigPush,
    private readonly control?: Pick<AgentControlStore, "get">,
  ) {}
  async plan(
    agent: Pick<AgentRecord, "id" | "workspaceId" | "computerId" | "stoppedAt">,
    change: AgentConfigChange,
  ): Promise<AgentConfigDecision> {
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
    const control = await this.control?.get(agent.id);
    const fence = runningFence(control);
    return planAgentConfig(agent, change, fence);
  }
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
function runningFence(agent: AgentControlAgent | undefined): ControlFence | undefined {
  const state = agent?.state;
  if (!agent || !state || state.phase !== "completed" || state.action === "stop") return;
  if (!current(agent, state)) return;
  return { controlState: agent.storedControlState };
}
