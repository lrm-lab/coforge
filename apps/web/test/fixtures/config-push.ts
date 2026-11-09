import { RUNTIME_PROVIDER, type AgentConfigSync } from "@lrm/coforge-sdk/internal";
import { AgentConfigApply } from "#src/server/agents/agent-config-apply.server";
import {
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlState,
} from "#src/server/agents/agent-control-types.server";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";

/** A running Agent record on a Computer, with the given fields overridden. */
export function running(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    computerId: "computer-1",
    name: "builder",
    displayName: "builder",
    createdAt: new Date(),
    runtimeConfig: {
      runtime: RUNTIME_PROVIDER.PI,
      provider: { kind: "default" },
      model: "old",
      modelProvider: "",
      reasoning: "",
    },
    ...overrides,
  };
}

/** The Agent's latest control operation: a Start that `completed` proves it is running. */
export type FakeControl = "completed" | "starting" | "failed" | "stopped" | "stale" | "none";

/** The control record `PrismaAgentControlStore.get` would read for `agent` under `control`. */
export function controlAgentOf(agent: AgentRecord, control: FakeControl): AgentControlAgent {
  const config = agent.runtimeConfig!;
  const state: AgentControlState | null =
    control === "none"
      ? null
      : {
          version: 1,
          protocolMajor: 1,
          requestId: "request-1",
          workspaceId: agent.workspaceId,
          computerId: agent.computerId!,
          agentId: agent.id,
          provider: config.runtime,
          epoch: 1,
          action: control === "stopped" ? "stop" : "start",
          phase:
            control === "starting"
              ? "starting"
              : control === "failed"
                ? "failed"
                : control === "stopped"
                  ? "stopped"
                  : "completed",
          configRevision: control === "stale" ? "old-hash" : agentControlRevision(config),
          launchId: "launch-1",
          controlSequence: 1,
          sessionSequence: 0,
        };
  return {
    id: agent.id,
    workspaceId: agent.workspaceId,
    computerId: agent.computerId!,
    ownerId: agent.ownerId,
    visibility: "public",
    runtimeConfig: config,
    storedControlState: state,
    state,
  };
}

/**
 * An `AgentConfigApply` over fakes: a Daemon that takes (or does not take) the push, the latest
 * control operation of the Agent `agent()` returns, and whether it is a Workspace Memory Agent.
 */
export type ConfigApplyOptions = {
  supported?: boolean;
  publishFails?: boolean;
  control?: FakeControl;
  memoryAgent?: boolean;
  /** The control state moves between the plan and the write (the fake repository throws). */
  fenceLost?: boolean;
  onPublish?: (sync: AgentConfigSync) => void;
};

export function configApplyOf(
  agent: () => AgentRecord | undefined,
  options: ConfigApplyOptions = {},
) {
  const intents: AgentConfigSync[] = [];
  const apply = new AgentConfigApply(
    {
      supports: async () => options.supported !== false,
      publish: async (sync) => {
        options.onPublish?.(sync);
        intents.push(sync);
        if (options.publishFails) throw new Error("centrifugo unavailable");
      },
    },
    {
      get: async () => {
        const record = agent();
        return record ? controlAgentOf(record, options.control ?? "completed") : undefined;
      },
    },
    {
      read: async () => ({
        workspaceId: "workspace-1",
        provider: "pi",
        reference: null,
        ...(options.memoryAgent ? { memoryAgent: true } : {}),
      }),
    },
  );
  return { apply, intents };
}
