import { expect, test } from "bun:test";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

/** The attention index wired to a real `AgentDeliveryGate` as `message-composition.ts` wires it,
 * with the Agent's deliveries held (a runtime-error backoff). */
function heldAgent() {
  const queue = new AgentDeliveryGate();
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acknowledgements.push(ack.deliveryId);
    },
    () => {},
    {
      shouldHold: (agentId) => queue.shouldHold(agentId),
      queued: (agentId) => queue.pending(agentId),
      enqueue: (agentId, message) => queue.enqueue(agentId, message),
      busy: (agentId) => queue.busy(agentId),
    },
  );
  queue.hold("agent-1", "rate_limit_backoff");
  return { queue, index, notices, acknowledgements };
}

/** The server delivers an answered or expired card as a delivery carrying the card's own
 * sequence, which the Agent wrote and so has already read. */
const card = (reason: "choice" | "expired") => ({
  ...delivery(reason),
  target: "@user",
  sequence: 5,
  reason,
});

for (const reason of ["choice", "expired"] as const) {
  test(`a held ${reason} card event notifies on flush though the Agent has read the card`, async () => {
    const { queue, index, notices, acknowledgements } = heldAgent();
    const event = card(reason);
    index.recordModelSeen(event.agentId, event.target, event.sequence);
    await index.receive(event);
    expect(queue.pending("agent-1")).toHaveLength(1);
    expect(acknowledgements).toEqual([event.deliveryId]);

    await index.flush("agent-1", queue.release("agent-1"));

    expect(notices).toHaveLength(1);
  });
}

test("a held card event the index never received is announced by the flush though the card is read", async () => {
  const { queue, index, notices } = heldAgent();
  const event = card("choice");
  index.recordModelSeen(event.agentId, event.target, event.sequence);
  queue.enqueue("agent-1", event);

  await index.flush("agent-1", queue.release("agent-1"));

  expect(notices).toHaveLength(1);
});

test("a held ordinary delivery the Agent read during the hold is still consumed by the flush", async () => {
  const { queue, index, notices } = heldAgent();
  const message = { ...delivery("ordinary"), target: "@user", sequence: 5 };
  await index.receive(message);
  index.recordModelSeen(message.agentId, message.target, message.sequence);

  await index.flush("agent-1", queue.release("agent-1"));

  expect(notices).toEqual([]);
});

test("a card event is never consumed, so an exited Agent is still told its read card was answered", () => {
  const { index } = heldAgent();
  const event = card("choice");
  const ordinary = { ...delivery("ordinary"), target: "@user", sequence: 5 };
  index.recordModelSeen(event.agentId, event.target, event.sequence);

  expect(index.hasConsumed(ordinary)).toBe(true);
  expect(index.hasConsumed(event)).toBe(false);
});

test("announcing a held card event the Agent has read still tells the session", async () => {
  const { index, notices } = heldAgent();
  const event = card("choice");
  index.recordModelSeen(event.agentId, event.target, event.sequence);
  await index.receive(event);

  expect(await index.announce(event)).toBe("told");
  expect(notices).toHaveLength(1);
});
