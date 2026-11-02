import { expect, test } from "bun:test";
import type { AgentSessionSnapshot } from "@lrm/coforge-sdk/internal";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState, type AgentRuntimeRecord } from "#src/agent-runtime/agent-runtime-state";

test("Session reporting persists before sending and replays the same snapshot after reconnect", async () => {
  let record: AgentRuntimeRecord = {
    version: 1,
    scope: {
      protocolMajor: 1,
      requestId: "request",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 1,
    },
    action: "start",
    phase: "running",
    daemonInstanceId: "daemon",
    sequence: 1,
    launchId: "launch",
  };
  const state = new AgentRuntimeState({
    listAgentIds: async () => ["a"],
    read: async () => structuredClone(record),
    write: async (_id, next) => {
      record = structuredClone(next);
    },
    clearWorkspace: async () => {
      throw new Error("Session must not clear workspace");
    },
  });
  const snapshots: AgentSessionSnapshot[] = [];
  const sessions = new AgentSessions(state, async (snapshot) => {
    expect(record.report).toEqual(snapshot);
    snapshots.push(snapshot);
    if (snapshots.length === 1) throw new Error("disconnected");
  });
  await sessions.update("a", "launch", { sessionId: "native", state: "resumable" });
  expect(record.identity).toEqual({ sessionId: "native", state: "resumable" });
  expect(record.phase).toBe("running");
  await new AgentSessions(state, async (snapshot) => {
    snapshots.push(snapshot);
  }).replay();
  expect(snapshots).toHaveLength(2);
  expect(snapshots[1]).toEqual(snapshots[0]);

  // Delayed callbacks queue behind a control transition, then recheck its fence.
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reset = state.run("a", async () => {
    entered.resolve();
    await release.promise;
    record = {
      ...record,
      scope: { ...record.scope, epoch: 2, requestId: "reset" },
      phase: "stopped",
    };
    sessions.clear(record);
  });
  await entered.promise;
  const stale = sessions.update("a", "launch", { sessionId: "native", state: "resumable" });
  release.resolve();
  await Promise.all([reset, stale]);
  expect(record.identity).toBeUndefined();
  expect(record.report).toBeUndefined();
  expect(record.phase).toBe("stopped");
  expect(snapshots).toHaveLength(2);
});

test("Session replay sends different Agents concurrently", async () => {
  const recordFor = (agentId: string): AgentRuntimeRecord => ({
    version: 1,
    scope: {
      protocolMajor: 1,
      requestId: `request-${agentId}`,
      workspaceId: "w",
      computerId: "c",
      agentId,
      provider: "pi",
      epoch: 1,
    },
    action: "start",
    phase: "running",
    daemonInstanceId: "daemon",
    sequence: 1,
    launchId: `launch-${agentId}`,
    report: {} as AgentSessionSnapshot,
  });
  const records = new Map([
    ["a", recordFor("a")],
    ["b", recordFor("b")],
  ]);
  const state = new AgentRuntimeState({
    listAgentIds: async () => [...records.keys()],
    read: async (agentId) => structuredClone(records.get(agentId)),
    write: async () => {},
    clearWorkspace: async () => {},
  });
  let active = 0;
  let maximum = 0;
  const sessions = new AgentSessions(state, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active -= 1;
  });

  await sessions.replay();

  expect(maximum).toBe(2);
});
