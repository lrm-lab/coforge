import { expect, test } from "bun:test";
import { AgentStopCoordinator } from "#src/daemon-runtime/agent-stop-coordinator";

/** A coordinator over inert collaborators, and what it told the credential holds. */
function subject() {
  const told: string[] = [];
  const coordinator = new AgentStopCoordinator({
    agentLaunches: new Map(),
    currentActivityLaunches: new Map(),
    inputDrain: { get: () => undefined },
    processManager: { isStopping: () => false, stop: async () => {} },
    activityPublisher: { forgetBusy() {}, publish() {} },
    desktops: { end() {} },
    agentApiKeys: new Map(),
    revokeAgentApiKey: async () => {},
    messageAttention: { clearAgent() {} },
    deliveryGate: { clearAgent() {} },
    runtimeErrorHold: { forget() {} },
    lifecycle: { stopped: (id: string) => told.push(id) },
    offlineResidency: { hasLaunchWait: () => false, forget() {} },
    sendAgentStatus() {},
    publishStopped() {},
  } as never);
  return { coordinator, told };
}

test("tearing a launch down is not a Stop: the credential records stay", async () => {
  const { coordinator, told } = subject();
  await coordinator.releaseAgentRuntime("a");
  expect(told).toEqual([]);
});

test("a person's Stop is told to the credential holds", async () => {
  const { coordinator, told } = subject();
  await coordinator.stopAgent("a");
  expect(told).toEqual(["a"]);
});
