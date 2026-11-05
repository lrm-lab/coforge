import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { delivery, session } from "./fixtures/attention-delivery";

/** A replay is the server sending one delivery again because its acknowledgement never landed.
 * What the daemon decides the second time is the difference between a notice and a phantom one. */
test("a replayed delivery the Agent already read is acknowledged, not announced again", async () => {
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acknowledgements.push(ack.deliveryId);
    },
  );
  const message = { ...delivery("replayed-read"), target: "#team", sequence: 7 };
  index.recordModelSeen(message.agentId, message.target, message.sequence);
  await index.receive(message);
  expect(notices).toEqual([]);
  acknowledgements.length = 0;

  // Same deliveryId again, as the replay arrives: consumed, and never in the notified set.
  await index.receive(message);
  expect(notices).toEqual([]);
  expect(acknowledgements).toEqual([message.deliveryId]);
});

test("a replayed delivery the Agent has not read still notifies once", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const message = { ...delivery("replayed-unread"), target: "#team", sequence: 8 };
  await index.receive(message);
  await index.receive(message);
  expect(notices).toHaveLength(1);
});
