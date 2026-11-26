import { expect, test } from "bun:test";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { captureDaemonLogs } from "./log-capture";
import { delivery, session } from "./fixtures/attention-delivery";

const decisions = async (run: () => Promise<unknown>) =>
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
      decision_basis: "read_frontier",
      request_id: message.requestId,
    }),
  ]);
});

test("a read's frontier is logged only for its own conversation", async () => {
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
      frontier_source: "unset",
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

test("a full preview suppresses replay without a read frontier or exact read", async () => {
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acknowledgements.push(ack.deliveryId);
    },
  );
  const message = {
    ...delivery("previewed", "human", "ada"),
    target: "#team",
    sequence: 5,
    attachmentCount: 0,
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
  };
  await index.receive(message);
  expect(notices[0]).toContain(message.body);
  const replay = { ...message, deliveryId: "delivery-preview-replay" };
  const recovery = { ...message, deliveryId: "delivery-preview-recovery" };
  const previewDecision = {
    outcome: "consumed",
    decision_basis: "full_preview",
    model_seen_seq: 0,
    exact_seen: false,
  };
  expect(await decisions(() => index.receive(replay))).toEqual([
    expect.objectContaining({ ...previewDecision, delivery_id: replay.deliveryId }),
  ]);
  expect(await decisions(() => index.recover(message.agentId, [recovery], {}))).toEqual([
    expect.objectContaining({ ...previewDecision, delivery_id: recovery.deliveryId }),
  ]);
  expect(notices).toHaveLength(1);
  expect(acknowledgements).toEqual([message.deliveryId, replay.deliveryId]);
});

test("a duplicate waits for the pending notice before it can be logged as already notified", async () => {
  const admission = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const activeSession = {
    ...session(),
    notify() {
      calls++;
      entered.resolve();
      return admission.promise;
    },
  };
  const acks: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => activeSession },
    async (ack) => {
      acks.push(ack.requestId);
    },
  );
  const message = {
    ...delivery("first"),
    target: "#team",
    sequence: 5,
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
  };
  const duplicate = { ...message, requestId: "request-in-flight" };

  expect(
    await decisions(async () => {
      const first = index.receive(message);
      let waiting: Promise<void> | undefined;
      try {
        await entered.promise;
        waiting = index.receive(duplicate);
        expect(await index.recover(message.agentId, [message], {})).toEqual(new Set());
        expect(acks).toEqual([]);
      } finally {
        admission.resolve();
        await Promise.all([first, waiting]);
      }
      await index.receive({ ...message, requestId: "request-after-acceptance" });
    }),
  ).toEqual([
    expect.objectContaining({ request_id: message.requestId, outcome: "notified" }),
    expect.objectContaining({ request_id: duplicate.requestId, outcome: "notification_in_flight" }),
    expect.objectContaining({ delivery_id: message.deliveryId, outcome: "notification_in_flight" }),
    expect.objectContaining({
      request_id: "request-after-acceptance",
      outcome: "already_notified",
      decision_basis: "delivery_generation",
    }),
  ]);
  expect(calls).toBe(1);
  expect(acks).toHaveLength(3);
});

test("recovery distinguishes a held delivery from acceptance after flush", async () => {
  const notices: string[] = [];
  const queued: ReturnType<typeof delivery>[] = [];
  const acknowledgements: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async (ack) => {
      acknowledgements.push(ack.deliveryId);
    },
    undefined,
    {
      shouldHold: () => true,
      enqueue: (_, message) => queued.push(message),
      busy: () => {},
    },
  );
  const message = {
    ...delivery("held"),
    target: "#team",
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
  };
  await index.receive(message);
  const recover = async () => {
    expect(await index.recover(message.agentId, [message], {})).toEqual(new Set());
  };
  expect(await decisions(recover)).toEqual([
    expect.objectContaining({ delivery_id: message.deliveryId, outcome: "held" }),
  ]);
  expect(notices).toHaveLength(0);
  expect(acknowledgements).toEqual([message.deliveryId]);

  await index.flush(message.agentId, queued);
  expect(await decisions(recover)).toEqual([
    expect.objectContaining({ delivery_id: message.deliveryId, outcome: "already_notified" }),
  ]);
  expect(notices).toHaveLength(1);
  expect(acknowledgements).toEqual([message.deliveryId]);
});

test("recovery reports a refused first notice as registered without acceptance", async () => {
  const notify = async () => {
    throw new Error("runtime refused");
  };
  const acknowledgements: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => ({ ...session(), notify }) },
    async (ack) => {
      acknowledgements.push(ack.deliveryId);
    },
  );
  const message = {
    ...delivery("refused"),
    target: "#team",
    latestSenderKind: "human" as const,
    latestSenderHandle: "ada",
    latestSenderDescription: "",
  };
  await expect(index.receive(message)).rejects.toThrow("runtime refused");
  const recover = async () => {
    expect(await index.recover(message.agentId, [message], {})).toEqual(new Set());
  };
  const recordedOnly = [
    expect.objectContaining({ delivery_id: message.deliveryId, outcome: "already_recorded" }),
  ];
  expect(await decisions(recover)).toEqual(recordedOnly);

  index.recordFullPreviews(message.agentId, [
    { target: message.target, conversationId: message.conversationId, sequence: message.sequence },
  ]);
  await index.flush(message.agentId, [message]);
  expect(index.wasNotified(message)).toBe(true);
  index.clearPreviewSeen(message.agentId);
  expect(await decisions(recover)).toEqual(recordedOnly);
  expect(acknowledgements).toEqual([]);
});
