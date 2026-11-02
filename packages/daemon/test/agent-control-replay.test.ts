import { expect, test } from "bun:test";
import type { AgentControlResult, AgentControlScope } from "@lrm/coforge-sdk/internal";
import { AgentControl } from "#src/agent-runtime/agent-control";
import {
  AgentRuntimeState,
  type AgentRuntimeRecord,
  type AgentRuntimeStateStore,
} from "#src/agent-runtime/agent-runtime-state";
import { AgentSessions } from "#src/agent-runtime/agent-session";

const scopeFor = (agentId: string): AgentControlScope => ({
  protocolMajor: 1,
  requestId: `request-${agentId}`,
  workspaceId: "w",
  computerId: "c",
  agentId,
  provider: "pi",
  epoch: 1,
});

test("Agent control replay sends different Agents concurrently", async () => {
  const records = new Map<string, AgentRuntimeRecord>();
  const store: AgentRuntimeStateStore = {
    listAgentIds: async () => [...records.keys()],
    read: async (agentId) => structuredClone(records.get(agentId)),
    write: async (agentId, record) => {
      records.set(agentId, structuredClone(record));
    },
    clearWorkspace: async () => {},
  };
  const state = new AgentRuntimeState(store);
  let active = 0;
  let maximum = 0;
  type ControlRuntime = ConstructorParameters<typeof AgentControl>[3];
  const runtime: ControlRuntime = {
    running: () => false,
    stop: async () => undefined,
    launch: async () => undefined,
    rebind: async () => undefined,
    result: async (_result: AgentControlResult) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
    },
  };
  const control = new AgentControl(
    "daemon",
    state,
    new AgentSessions(state, async () => {}),
    runtime,
  );

  await control.stop(scopeFor("a"));
  await control.stop(scopeFor("b"));
  active = 0;
  maximum = 0;

  await control.replay();

  expect(maximum).toBe(2);
});
