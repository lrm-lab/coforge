import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";

const runtimeConfig = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

function pendingAgent(action: "start" | "stop", requestId: string) {
  const scope = {
    protocolMajor: 1 as const,
    requestId,
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi" as const,
    epoch: 3,
    launchId: "launch-a",
  };
  const agent: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    visibility: "private",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    state: {
      ...scope,
      version: 1,
      action,
      phase: action === "start" ? "starting" : "stopping",
      configRevision: agentControlRevision(runtimeConfig),
      launchId: "launch-a",
      controlSequence: 0,
      sessionSequence: 0,
    },
  };
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => structuredClone(agent),
    replace: async (before, state) => {
      if (JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent.state = structuredClone(state);
      return true;
    },
  };
  return { agent, store, scope };
}

function controlWithRecorder(
  store: AgentControlStore,
  recorded: Array<{ agentId: string; reason: string }>,
) {
  return new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (failed, reason) => {
      recorded.push({ agentId: failed.id, reason });
    },
  );
}

test("a terminally failed operation records its reason for the Agent's display", async () => {
  const { agent, store, scope } = pendingAgent("start", "start-1");
  const recorded: Array<{ agentId: string; reason: string }> = [];
  const control = controlWithRecorder(store, recorded);
  await control.result(scope, {
    ...scope,
    sequence: 1,
    phase: "failed",
    errorCode: "runtime_login_required",
  });
  expect(agent.state?.phase).toBe("failed");
  expect(recorded).toEqual([{ agentId: "a", reason: "runtime_login_required" }]);
});

test("a failed stop records no stop reason", async () => {
  const { agent, store, scope } = pendingAgent("stop", "stop-1");
  const recorded: Array<{ agentId: string; reason: string }> = [];
  const control = controlWithRecorder(store, recorded);
  await control.result(scope, {
    ...scope,
    sequence: 1,
    phase: "failed",
    errorCode: "stop_unconfirmed",
  });
  expect(agent.state?.phase).toBe("failed");
  expect(recorded).toEqual([]);
});

test("a failed result without an error code records nothing", async () => {
  const { agent, store, scope } = pendingAgent("start", "start-2");
  const recorded: Array<{ agentId: string; reason: string }> = [];
  const control = controlWithRecorder(store, recorded);
  await control.result(scope, {
    ...scope,
    sequence: 1,
    phase: "failed",
  });
  expect(agent.state?.phase).toBe("failed");
  expect(recorded).toEqual([]);
});
