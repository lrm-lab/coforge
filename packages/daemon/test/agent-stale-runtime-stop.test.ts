import { expect, test } from "bun:test";
import { AgentControl } from "#src/agent-runtime/agent-control";
import { AgentSessions } from "#src/agent-runtime/agent-session";
import { AgentRuntimeState, type AgentRuntimeRecord } from "#src/agent-runtime/agent-runtime-state";

test("stale runtime stop releases only when the local fence is older", async () => {
  let record: AgentRuntimeRecord = {
    version: 1,
    scope: {
      protocolMajor: 1,
      requestId: "start",
      workspaceId: "w",
      computerId: "old-computer",
      agentId: "a",
      provider: "pi",
      epoch: 3,
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
    clearWorkspace: async () => {},
  });
  let running = true;
  let stops = 0;
  const control = new AgentControl("daemon", state, new AgentSessions(state, async () => {}), {
    running: () => running,
    stop: async () => {
      stops++;
      running = false;
    },
    rebind: async () => undefined,
    launch: async () => undefined,
    result: async () => {},
  });

  expect(await control.staleRuntimeStop("a", 3)).toBe("rejected");
  expect(stops).toBe(0);
  expect(await control.staleRuntimeStop("a", 4)).toBe("released");
  expect(stops).toBe(1);
  expect(record.phase).toBe("stopped");
});
