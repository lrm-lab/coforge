import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { delivery, session } from "./fixtures/attention-delivery";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("a replacement session does not recover a message already consumed by the prior session", async () => {
  const root = join(tmpdir(), `coforge-replay-${crypto.randomUUID()}`);
  try {
    const notices: string[] = [];
    const index = new AgentMessageAttentionIndex(
      "workspace-1",
      { session: () => session((notice) => notices.push(notice)) },
      async () => {},
      () => {},
      {
        shouldHold: () => false,
        enqueue: () => {},
        busy: () => {},
        consumedSeqs: new AgentConsumedSeqStore(root),
      },
    );
    const message = {
      messageId: "message-recovery-consumed",
      deliveryId: "delivery-recovery-consumed",
      conversationId: "conversation-1",
      sequence: 1,
      target: "@ada",
      latestSenderKind: "human" as const,
      latestSenderHandle: "ada",
      latestSenderDescription: "",
      body: "already consumed",
    };
    index.bindConversation("agent-1", message.target, message.conversationId);
    index.recordModelSeen("agent-1", message.target, message.sequence);
    await index.recover("agent-1", [message], { "@ada": 1 });
    expect(notices).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an answer to the Agent's own card notifies even though the card is already read", async () => {
  // The server delivers an answered card as a `choice` delivery carrying the card's own
  // sequence, and the Agent wrote (so read) that card: the read state cannot cover the answer.
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const card = { ...delivery("card"), target: "@user", sequence: 2269, reason: "choice" };
  index.recordModelSeen(card.agentId, card.target, card.sequence);
  await index.receive(card);
  expect(notices).toHaveLength(1);
  // The answer is announced once: a replay of the same delivery adds nothing.
  await index.receive(card);
  expect(notices).toHaveLength(1);
});

test("an expired card notifies its author too, though the card is already read", async () => {
  const notices: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async () => {},
  );
  const card = { ...delivery("expired"), target: "@user", sequence: 2280, reason: "expired" };
  index.recordModelSeen(card.agentId, card.target, card.sequence);
  await index.receive(card);
  expect(notices).toHaveLength(1);
});
