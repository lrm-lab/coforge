import { expect, test } from "bun:test";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { AgentInputDrain, type AgentInputDrainPorts } from "#src/daemon-runtime/agent-input-drain";
import { AgentLaunchCustody } from "#src/daemon-runtime/agent-launch-custody";

const AGENT = "agent-1";

const delivery = (id: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: AGENT,
  body: "body",
  method: "agent:v1:message:deliver",
  target: "#general",
});

/** A custody over a real delivery gate whose Agent is mid-turn: its busy mark stands. */
function midTurn(options: { hasLiveTurn?: boolean } = {}) {
  const gate = new AgentDeliveryGate();
  gate.busy(AGENT);
  const told: string[][] = [];
  const custody = new AgentLaunchCustody({
    deliveryGate: gate,
    inputDrain: {
      tellCarried: async (_: string, held: AgentMessageDelivery[]) =>
        void told.push(held.map(({ deliveryId }) => deliveryId)),
    },
    agentProcessManager: { session: () => ({ hasLiveTurn: options.hasLiveTurn }) },
  } as never);
  return { gate, custody, told };
}

test("presenting what a launch kept does not clear the busy mark of a turn in progress", async () => {
  const { gate, custody, told } = midTurn({ hasLiveTurn: true });

  await custody.flushSurvivingDeliveries(AGENT);

  expect(gate.isBusy(AGENT)).toBe(true);
  expect(told).toEqual([[]]);
});

test("a turn the daemon just opened with a notice keeps its busy mark though the provider cannot say", async () => {
  const { gate, custody } = midTurn();

  await custody.flushSurvivingDeliveries(AGENT);

  expect(gate.isBusy(AGENT)).toBe(true);
});

test("deliveries held for a queue-until-idle provider stay held through a turn in progress", async () => {
  const { gate, custody, told } = midTurn({ hasLiveTurn: true });
  gate.setMode(AGENT, "queue_until_idle");
  gate.enqueue(AGENT, delivery("a"));

  await custody.flushSurvivingDeliveries(AGENT);

  expect(told).toEqual([[]]);
  expect(gate.pending(AGENT).map(({ deliveryId }) => deliveryId)).toEqual(["delivery-a"]);
});

test("an idle session still takes what was held across an exit, and is marked idle", async () => {
  const { gate, custody, told } = midTurn({ hasLiveTurn: false });
  gate.enqueue(AGENT, delivery("a"));
  // A stale mark from before the exit: the session reports it has no turn.
  await custody.flushSurvivingDeliveries(AGENT);

  expect(told).toEqual([["delivery-a"]]);
  expect(gate.isBusy(AGENT)).toBe(false);
});

/** The input drain over real custody and gate, with a recovery that already told the mentions. */
test("a carried item that finds nothing kept leaves the Agent busy", async () => {
  const gate = new AgentDeliveryGate();
  gate.busy(AGENT);
  const state = { asked: 0, presented: 0 };
  const custody = new AgentLaunchCustody({
    deliveryGate: gate,
    inputDrain: { tellCarried: async () => void state.presented++ },
    agentProcessManager: { session: () => ({ hasLiveTurn: undefined }) },
  } as never);
  const drain = new AgentInputDrain({
    runnerHeld: () => false,
    sessionFor: () => ({}),
    launchFor: () => undefined,
    // Kept when the launch queues the item; told by the recovery pass before the item runs.
    hasCarried: () => state.asked++ === 0,
    presentKept: (agentId: string) => custody.flushSurvivingDeliveries(agentId),
  } as unknown as AgentInputDrainPorts);

  drain.ensure(AGENT);
  await Promise.all(drain.drains());

  expect(gate.isBusy(AGENT)).toBe(true);
  expect(state.presented).toBe(0);
});
