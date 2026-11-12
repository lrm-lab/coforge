import { expect, test } from "bun:test";
import {
  AgentControlReceiver,
  AgentLaunchRefusalError,
  type AgentLaunchRefusalCode,
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
 * tell a superseded scope from an Agent mid-move. */

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

/** The code a refused claim carries, or undefined when it was accepted. */
async function refusal(
  claim: Parameters<AgentControlReceiver["authorizeLaunch"]>[0],
  stored: AgentControlAgent | undefined,
): Promise<AgentLaunchRefusalCode | undefined> {
  try {
    await receiver(stored).authorizeLaunch(claim);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentLaunchRefusalError);
    return (error as AgentLaunchRefusalError).code;
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

test("an Agent this Computer cannot see is not authorized", async () => {
  expect(await refusal(managedClaim, undefined)).toBe("AGENT_LAUNCH_NOT_AUTHORIZED");
});

test("a claim for another Computer is not authorized", async () => {
  expect(await refusal({ ...managedClaim, computerId: "computer-b" }, agent)).toBe(
    "AGENT_LAUNCH_NOT_AUTHORIZED",
  );
});

test("an Agent being moved is refused as migrating, not as a stale scope", async () => {
  expect(await refusal(managedClaim, { ...agent, migrating: true })).toBe("AGENT_MIGRATING");
});

test("a managed scope with no stored state is unsolicited", async () => {
  expect(await refusal(managedClaim, agent)).toBe("AGENT_LAUNCH_UNSOLICITED");
});

test("a scope the stored state does not carry is stale", async () => {
  expect(
    await refusal(managedClaim, {
      ...agent,
      state: state({ launchId: "launch-newer" }),
    }),
  ).toBe("AGENT_LAUNCH_SUPERSEDED");
});

test("a completed start chain accepts the same scope, a stopped Agent does not", async () => {
  const started = { ...agent, state: state({ phase: "completed" }) };
  expect(await refusal(managedClaim, started)).toBeUndefined();
  // A person's Stop is never undone by a daemon-initiated relaunch resending its old scope.
  expect(await refusal(managedClaim, { ...started, stoppedAt: new Date() })).toBe(
    "AGENT_LAUNCH_SUPERSEDED",
  );
});
