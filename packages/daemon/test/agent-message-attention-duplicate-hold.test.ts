import { expect, test } from "bun:test";
import { AgentDeliveryQueue } from "#src/daemon-runtime/agent-delivery-queue";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

/** The attention index wired to a real `AgentDeliveryQueue` as `message-composition.ts` wires it,
 * with the Agent's deliveries held (a runtime-error backoff). */
function heldAgent() {
  const queue = new AgentDeliveryQueue();
  const notices: string[] = [];
  const acks: { deliveryId: string; requestId: string }[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acks.push({ deliveryId: ack.deliveryId, requestId: ack.requestId });
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
  return { queue, index, notices, acks };
}

test("a resend of a held delivery adds no second entry but is acknowledged, and one notice follows", async () => {
  const { queue, index, notices, acks } = heldAgent();

  await index.receive(delivery("one"));
  await index.receive({ ...delivery("one"), requestId: "request-one-resent" });

  expect(queue.pending("agent-1").map((held) => held.deliveryId)).toEqual(["delivery-one"]);
  // Each request is acknowledged as the daemon takes it, so the server stops replaying it.
  expect(acks).toEqual([
    { deliveryId: "delivery-one", requestId: "request-one" },
    { deliveryId: "delivery-one", requestId: "request-one-resent" },
  ]);

  // The resend stays held instead of notifying again.
  expect(notices).toEqual([]);

  await index.flush("agent-1", queue.release("agent-1"));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("@agent 1 new message");
});
