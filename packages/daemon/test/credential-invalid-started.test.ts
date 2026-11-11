import { beforeEach, expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@lrm/coforge-anvil";
import { CredentialInvalidHolds } from "#src/daemon-runtime/credential-invalid-holds";

// Task #39: a person's Start is the probe for a credential the Agent showed unusable. It ends the
// record and hands what the hold kept to a live Agent; with no process running it must launch
// nothing of its own, because the Start that called it is the launch.

const AGENT = "agent-a";
const config: AgentRuntimeConfig = {
  provider: "pi",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};

/** The four side effects this test tells apart, and the gate's own hold bookkeeping. */
function fakes(running: boolean, agentConfig: AgentRuntimeConfig = config) {
  const held = new Set<string>();
  const calls: string[] = [];
  const restored: { agentId: string; releaseCause: string }[] = [];
  const holds = new CredentialInvalidHolds({
    deliveryGate: {
      credentialHeld: (agentId) => held.has(agentId),
      heldFor: (reason) => (reason === "credential_invalid" ? [...held] : []),
      endHold: (agentId) => {
        calls.push(`endHold:${agentId}`);
        held.delete(agentId);
      },
    },
    hold: (agentId) => {
      held.add(agentId);
      return true;
    },
    runningAgentIds: () => (running ? [AGENT] : []),
    isRunning: () => running,
    configOf: () => agentConfig,
    present: (agentId) => calls.push(`present:${agentId}`),
    wake: (agentId) => calls.push(`wake:${agentId}`),
    notice: () => {},
    noticeText: () => "",
    launchId: () => "launch-1",
    restored: (report) =>
      restored.push({ agentId: report.agentId, releaseCause: report.releaseCause }),
  });
  return { holds, calls, restored, held };
}

let held: ReturnType<typeof fakes>;
beforeEach(() => {
  held = fakes(true);
});

test("a person's Start hands what the hold kept to the live Agent, and never wakes it", () => {
  held.holds.record(AGENT, config, "user_reauth");
  held.calls.length = 0;

  held.holds.started(AGENT);

  expect(held.calls).toEqual([`endHold:${AGENT}`, `present:${AGENT}`]);
  expect(held.restored).toEqual([{ agentId: AGENT, releaseCause: "explicit_start" }]);
  expect(held.holds.isHeld(AGENT)).toBe(false);
});

test("a person's Start with no process running ends the hold without a wake of its own", () => {
  const stopped = fakes(false);
  stopped.holds.record(AGENT, config, "user_reauth");
  stopped.calls.length = 0;

  stopped.holds.started(AGENT);

  // The Start that called this is the launch: a wake here would start a second one beside it.
  expect(stopped.calls).toEqual([`endHold:${AGENT}`]);
  expect(stopped.holds.isHeld(AGENT)).toBe(false);
});

test("a credential that changes by itself still wakes an Agent with no process", () => {
  // A runtime that keeps its own sign-in: its record answers to the shared key, not the Agent's.
  const shared: AgentRuntimeConfig = { ...config, provider: "claude-code" };
  const stopped = fakes(false, shared);
  stopped.holds.record(AGENT, shared, "user_reauth");
  stopped.calls.length = 0;

  stopped.holds.signedIn("claude-code");

  expect(stopped.calls).toEqual([`endHold:${AGENT}`, `wake:${AGENT}`]);
});
