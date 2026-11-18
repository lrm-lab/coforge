import { expect, test } from "bun:test";
import { AgentControl, type LaunchRetryScheduler } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import {
  AgentRuntimeState,
  type AgentRuntimeRecord,
  type AgentRuntimeStateStore,
} from "#src/agent-runtime/agent-runtime-state";
import type { AgentControlResult, AgentControlScope } from "@lrm/coforge-sdk/internal";

const inertRetryScheduler: LaunchRetryScheduler = { schedule: () => undefined, cancel: () => {} };

const scope: AgentControlScope = {
  protocolMajor: 1,
  requestId: "start-1",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "codex",
  epoch: 7,
};

function fixture(
  initial?: Partial<AgentRuntimeRecord> & { epoch?: number },
  options: { sendFails?: boolean } = {},
) {
  let record: AgentRuntimeRecord | undefined = initial && {
    version: 1,
    scope: { ...scope, epoch: initial.epoch ?? scope.epoch },
    action: "start",
    phase: "running",
    daemonInstanceId: "daemon",
    sequence: 4,
    ...initial,
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
  const control = new AgentControl(
    "daemon",
    state,
    new AgentSessions(state, async () => {}),
    {
      running: () => false,
      stop: async () => undefined,
      async launch() {
        throw new Error("a rejected Start must never launch");
      },
      async rebind() {
        throw new Error("a rejected Start must never rebind");
      },
      async result(result) {
        if (options.sendFails) throw new Error("offline");
        results.push(result);
      },
    },
    inertRetryScheduler,
  );
  return { control, results, record: () => record };
}

test("with no record at all, as after a Daemon restart, a rejected Start answers failed with sequence 1", async () => {
  const { control, results, record } = fixture();
  await control.rejectStart(scope, "start_intent_rejected");
  expect(results).toEqual([
    { ...scope, phase: "failed", sequence: 1, errorCode: "start_intent_rejected" },
  ]);
  expect(record()).toBeUndefined();
});

test("a record of an older epoch does not number the receipt: it is 1 again", async () => {
  const { control, results } = fixture({ epoch: 6, sequence: 9 });
  await control.rejectStart(scope, "start_intent_rejected");
  expect(results.map((result) => result.sequence)).toEqual([1]);
});

test("the same rejected Start repeated on every reconnect always carries the same sequence", async () => {
  const { control, results } = fixture();
  for (let i = 0; i < 5; i++) await control.rejectStart(scope, "start_intent_rejected");
  expect(results.map((result) => result.sequence)).toEqual([1, 1, 1, 1, 1]);
});

test("an epoch the Daemon already holds a record for is never failed by a bad republished Start", async () => {
  for (const phase of ["starting", "running", "failed", "stopped"] as const) {
    const { control, results } = fixture({ phase });
    await control.rejectStart(scope, "start_intent_rejected");
    expect(results, phase).toEqual([]);
  }
});

test("a Start older than the Daemon's record is not answered", async () => {
  const { control, results } = fixture({ epoch: 9 });
  await control.rejectStart(scope, "start_intent_rejected");
  expect(results).toEqual([]);
});

test("a receipt that cannot be sent is swallowed like every other", async () => {
  const { control } = fixture(undefined, { sendFails: true });
  await expect(control.rejectStart(scope, "start_intent_rejected")).resolves.toBeUndefined();
});
