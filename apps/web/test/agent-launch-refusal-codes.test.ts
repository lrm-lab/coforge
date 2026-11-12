import { expect, test } from "bun:test";
import {
  AgentControlReceiver,
  AgentLaunchRefusalError,
} from "#src/server/agents/agent-control-receiver.server";
import {
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlState,
  type AgentControlStore,
} from "#src/server/agents/agent-control-types.server";

/** Task #14: a launch the server refuses must name why. Before the codes, every refusal on the
 * mint path became one bare 403, so a Daemon whose relaunch was refused could report only "the
 * server refused this Computer's request for the Agent's launch credentials" — and nobody could
 * tell a stopped Agent from a failed operation from a scope that had moved on. */

const agent: AgentControlAgent = {
  id: "agent-a",
  workspaceId: "workspace-a",
  computerId: "computer-a",
  ownerId: "owner-a",
  visibility: "public",
  runtimeConfig: {
    runtime: "pi",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
  },
  state: null,
};

/** One stored control state, valid against `agent` unless a case moves a fence. */
function state(overrides: Partial<AgentControlState> = {}): AgentControlState {
  return {
    version: 1,
    protocolMajor: 1,
    requestId: "req-a",
    workspaceId: agent.workspaceId,
    computerId: agent.computerId,
    agentId: agent.id,
    provider: "pi",
    epoch: 3,
    action: "start",
    phase: "starting",
    configRevision: agentControlRevision(agent.runtimeConfig),
    launchId: "launch-a",
    controlSequence: 1,
    sessionSequence: 0,
    ...overrides,
  };
}

function receiver(stored: AgentControlAgent | undefined) {
  const store: AgentControlStore = {
    async get() {
      return stored === undefined ? undefined : structuredClone(stored);
    },
    async replace() {
      return false;
    },
    memberRole: async () => "owner",
  };
  return new AgentControlReceiver(store, {} as never, {} as never);
}

/** The refusal a claim drew, or undefined when it was accepted. */
async function refusal(
  claim: Parameters<AgentControlReceiver["authorizeLaunch"]>[0],
  stored: AgentControlAgent | undefined,
): Promise<AgentLaunchRefusalError | undefined> {
  try {
    await receiver(stored).authorizeLaunch(claim);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentLaunchRefusalError);
    return error as AgentLaunchRefusalError;
  }
}

const managedClaim = {
  agentId: agent.id,
  workspaceId: agent.workspaceId,
  computerId: agent.computerId,
  controlEpoch: 3,
  requestId: "req-a",
  launchId: "launch-a",
};

test("an Agent this Computer cannot see, or one on another Computer, is not authorized", async () => {
  expect((await refusal(managedClaim, undefined))?.code).toBe("AGENT_LAUNCH_NOT_AUTHORIZED");
  expect((await refusal({ ...managedClaim, computerId: "computer-b" }, agent))?.code).toBe(
    "AGENT_LAUNCH_NOT_AUTHORIZED",
  );
});

test("an Agent being moved is refused as migrating, not as a stale scope", async () => {
  expect((await refusal(managedClaim, { ...agent, migrating: true }))?.code).toBe(
    "AGENT_MIGRATING",
  );
});

test("a managed scope with no stored state is unsolicited", async () => {
  expect((await refusal(managedClaim, agent))?.code).toBe("AGENT_LAUNCH_UNSOLICITED");
});

test("a stored state from another configuration is a config change, not a superseded scope", async () => {
  const refused = await refusal(managedClaim, {
    ...agent,
    state: state({ configRevision: "0".repeat(64) }),
  });
  expect(refused?.code).toBe("AGENT_LAUNCH_CONFIG_CHANGED");
});

test("a starting operation whose stored scope does not match is superseded", async () => {
  const refused = await refusal(managedClaim, {
    ...agent,
    state: state({ launchId: "launch-newer" }),
  });
  expect(refused?.code).toBe("AGENT_LAUNCH_SUPERSEDED");
  expect(refused?.facts).toEqual({
    phase: "starting",
    action: "start",
    sameScope: false,
    stoppedAt: false,
  });
});

test("a completed start chain accepts the same scope", async () => {
  expect(await refusal(managedClaim, { ...agent, state: state({ phase: "completed" }) })).toBe(
    undefined,
  );
});

test("a person's Stop is named as stopped, whether by the chain or the Agent's own flag", async () => {
  const stoppedChain = await refusal(managedClaim, {
    ...agent,
    state: state({ phase: "completed", action: "stop" }),
  });
  expect(stoppedChain?.code).toBe("AGENT_LAUNCH_STOPPED");
  expect(stoppedChain?.facts.action).toBe("stop");
  const stoppedAgent = await refusal(managedClaim, {
    ...agent,
    stoppedAt: new Date(),
    state: state({ phase: "completed" }),
  });
  expect(stoppedAgent?.code).toBe("AGENT_LAUNCH_STOPPED");
  expect(stoppedAgent?.facts.stoppedAt).toBe(true);
});

test("a failed operation is not resumable, which is different from a scope that moved", async () => {
  const failed = await refusal(managedClaim, {
    ...agent,
    state: state({ phase: "failed" }),
  });
  expect(failed?.code).toBe("AGENT_LAUNCH_NOT_RESUMABLE");
  expect(failed?.facts.phase).toBe("failed");
  // Same phase, same Agent, only the scope differs.
  const moved = await refusal(managedClaim, {
    ...agent,
    state: state({ phase: "completed", requestId: "req-b" }),
  });
  expect(moved?.code).toBe("AGENT_LAUNCH_SUPERSEDED");
});
