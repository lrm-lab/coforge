import { expect, test } from "bun:test";
import { AgentControl, type LaunchRetryScheduler } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import {
  AgentRuntimeState,
  type AgentRuntimeRecord,
  type AgentRuntimeStateStore,
} from "#src/agent-runtime/agent-runtime-state";
import type {
  AgentControlResult,
  AgentControlScope,
  AgentStartIntent,
} from "@lrm/coforge-sdk/internal";

/** No launch in this file ends in a retryable failure, so no automatic retry is ever armed. */
const inertRetryScheduler: LaunchRetryScheduler = {
  schedule: () => undefined,
  cancel: () => {},
};

const scope: AgentControlScope = {
  protocolMajor: 1,
  requestId: "start-1",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "codex",
  epoch: 7,
};

const intent: AgentStartIntent = {
  protocolMajor: 1,
  requestId: scope.requestId,
  workspaceId: scope.workspaceId,
  computerId: scope.computerId,
  agentId: scope.agentId,
  provider: scope.provider,
  model: "",
  reasoning: "",
  controlEpoch: scope.epoch,
  launchId: "launch-1",
};

const failedResult: AgentControlResult = {
  ...scope,
  phase: "failed",
  launchId: "launch-1",
  sequence: 1,
  errorCode: "agent_authorization_failed",
  errorDetail: "the Agent's launch configuration was refused by the server",
};

function failedStartFixture(options: { lastResult?: AgentControlResult | null } = {}) {
  const lastResult = options.lastResult === null ? undefined : (options.lastResult ?? failedResult);
  let record: AgentRuntimeRecord | undefined = {
    version: 1,
    scope,
    action: "start",
    phase: "failed",
    daemonInstanceId: "daemon",
    sequence: 1,
    launchId: "launch-1",
    ...(lastResult ? { lastResult } : {}),
  };
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [],
    read: async () => record && structuredClone(record),
    write: async (_id, value) => {
      record = structuredClone(value);
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  const results: AgentControlResult[] = [];
  let launches = 0;
  const control = new AgentControl(
    "daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      stop: async () => undefined,
      async launch() {
        launches += 1;
        return { sessionId: "native-1", state: "empty" };
      },
      async rebind() {
        throw new Error("must not rebind a failed operation");
      },
      async result(result) {
        results.push(result);
      },
    },
    inertRetryScheduler,
  );
  return { control, results, record: () => record, launches: () => launches };
}

test("a republished Start for an already-failed operation replays its terminal result", async () => {
  const { control, results, launches } = failedStartFixture();
  await control.start(intent);
  expect(launches()).toBe(0);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    phase: "failed",
    requestId: "start-1",
    epoch: 7,
    launchId: "launch-1",
    sequence: 1,
    errorCode: "agent_authorization_failed",
    errorDetail: failedResult.errorDetail,
  });
});

test("a failed record without a stored result synthesizes the terminal result for the same operation", async () => {
  const { control, results, record } = failedStartFixture({ lastResult: null });
  await control.start(intent);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    phase: "failed",
    requestId: "start-1",
    epoch: 7,
    launchId: "launch-1",
    errorCode: "runtime_spawn_failed",
  });
  expect(record()?.lastResult).toMatchObject({
    phase: "failed",
    requestId: "start-1",
    epoch: 7,
    launchId: "launch-1",
  });
  const first = results[0]!;
  await control.start(intent);
  expect(results).toHaveLength(2);
  expect(results[1]).toMatchObject({
    phase: "failed",
    requestId: "start-1",
    epoch: 7,
    sequence: first.sequence,
  });
});

test("a same-epoch Start under a different requestId does not replay the failed result", async () => {
  const { control, results } = failedStartFixture();
  await expect(control.start({ ...intent, requestId: "start-2" })).rejects.toThrow(
    "control_request_mismatch",
  );
  expect(results).toHaveLength(0);
});
