import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AgentControl, agentControlRevision } from "#src/server/agents/agent-control.server";
import type {
  AgentControlAgent,
  AgentControlStore,
} from "#src/server/agents/agent-control-types.server";

const runtimeConfig = {
  runtime: RUNTIME_PROVIDER.PI,
  provider: { kind: "default" as const },
  model: "claude-3-5-sonnet",
  modelProvider: "anthropic",
  reasoning: "",
};

test("clearLaunchFailure clears terminal failure, increments controlSequence, and notifies", async () => {
  let stored: AgentControlAgent = {
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "fail-req",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 1,
      action: "start",
      phase: "failed",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 3,
      sessionSequence: 0,
      errorCode: "runtime_private",
      failedAtMs: Date.now(),
    },
  };

  const store: AgentControlStore = {
    get: async () => stored,
    replace: async (_before, next) => {
      stored = { ...stored, state: next };
      return true;
    },
    memberRole: async () => undefined,
  };

  const control = new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { timeoutMs: 0 },
  );

  const ok = await control.clearLaunchFailure("a", "runtime_private");
  expect(ok).toBe(true);
  expect(stored.state).toMatchObject({
    phase: "completed",
    controlSequence: 4,
  });
  expect(stored.state?.errorCode).toBeUndefined();
  expect(stored.state?.failedAtMs).toBeUndefined();

  // Second attempt is false because phase is already completed, not failed
  const skipped = await control.clearLaunchFailure("a", "runtime_private");
  expect(skipped).toBe(false);
});
