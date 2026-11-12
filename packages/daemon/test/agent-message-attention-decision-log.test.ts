import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { captureDaemonLogs } from "./log-capture";
import { delivery, session } from "./fixtures/attention-delivery";

/** What the decision line has to say for a phantom notice to be explainable afterwards: which
 * conversation the delivery names, which one the cursor counts in, and what last moved the cursor
 * (task #4). Every field here is diagnostics: no decision reads any of them. */
const decisions = async (run: () => Promise<void>) =>
  (await captureDaemonLogs(run)).records
    .filter((record) => record.properties.event === "agent.message.attention_decision")
    .map((record) => record.properties);

test("a consumed decision names both conversations and the frontier a notice moved", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  index.recordModelSeen("agent-1", "#team", 6);
  const message = { ...delivery("consumed"), target: "#team", sequence: 5 };

  expect(await decisions(() => index.receive(message))).toEqual([
    expect.objectContaining({
      delivery_id: "delivery-consumed",
      conversation_id: "conversation-1",
      bound_conversation_id: "conversation-1",
      model_seen_seq: 6,
      frontier_source: "model_seen",
      outcome: "consumed",
    }),
  ]);
});

test("a read's frontier says so, and a second conversation's delivery reads as unbound-then-reset", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  index.recordHistoryRead("agent-1", {
    spelling: "#team",
    target: "#team",
    shown: [1, 2],
    through: 2,
  });
  expect(
    await decisions(() => index.receive({ ...delivery("read"), target: "#team", sequence: 3 })),
  ).toEqual([
    expect.objectContaining({
      sequence: 3,
      conversation_id: "conversation-1",
      bound_conversation_id: "conversation-1",
      model_seen_seq: 2,
      frontier_source: "history_read",
      outcome: "notified",
    }),
  ]);

  // The channel was recreated under the same name: the same target now counts another
  // conversation, so its cursor is dropped before the decision that follows.
  const recreated = {
    ...delivery("recreated"),
    conversationId: "conversation-2",
    target: "#team",
    sequence: 1,
  };
  expect(await decisions(() => index.receive(recreated))).toEqual([
    expect.objectContaining({
      conversation_id: "conversation-2",
      bound_conversation_id: "conversation-2",
      model_seen_seq: 0,
      frontier_source: "reset",
      outcome: "notified",
    }),
  ]);
});

test("a target nothing has ever moved reports an unset frontier rather than a number", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
  );
  expect(
    await decisions(() => index.receive({ ...delivery("fresh"), target: "#new", sequence: 4 })),
  ).toEqual([
    expect.objectContaining({
      target: "#new",
      bound_conversation_id: "conversation-1",
      model_seen_seq: 0,
      frontier_source: "unset",
      exact_seen: false,
    }),
  ]);
});
