import { expect, test } from "bun:test";
import { settleForwardedTaskRead } from "#src/daemon-runtime/agent-history-read";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { heldTaskResult } from "#src/daemon-runtime/held-task-result";
import { buildNoticeRows } from "#src/daemon-runtime/inbox-preview-rows";
import type {
  AgentConsumedSeqDelta,
  AgentConsumedSeqPort,
  AgentConsumedSeqState,
} from "#src/persistence/agent-consumed-seq-store";
import { delivery, session } from "./fixtures/attention-delivery";
import { messageRecord } from "./fixtures/message-record";

const agentId = "agent-1";
const target = "#team:#42";

function taskRead(index: AgentMessageAttentionIndex, conversationId: string, through: number) {
  settleForwardedTaskRead(
    index,
    agentId,
    { unread: "true" },
    {
      consumptionScope: { agentId, conversationId, channelType: "thread", target },
      messages: [],
      moreUnread: false,
      modelSeenUpToSeq: through,
    },
  );
}

function attention(consumedSeqs?: AgentConsumedSeqPort) {
  const notices: string[] = [];
  const acknowledgements: string[] = [];
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session((notice) => notices.push(notice)) },
    async ({ deliveryId }) => {
      acknowledgements.push(deliveryId);
    },
    () => {},
    { shouldHold: () => false, enqueue: () => {}, busy: () => {}, consumedSeqs },
  );
  return { index, notices, acknowledgements };
}

test("scoped cursors are restored alongside a legacy slot for only the replacement", async () => {
  const saved = {
    targets: { [target]: { conversationId: "replacement", seq: 7 } },
    aliases: {},
    nextReadOrder: 1,
    scopedTargets: [
      { target, entry: { conversationId: "original", seq: 31 } },
      { target, entry: { conversationId: "replacement", seq: 7 } },
    ],
  } satisfies AgentConsumedSeqState & { scopedTargets: unknown };
  const { index, notices } = attention({ read: () => saved, write: () => {} });

  await index.receive({
    ...delivery("original-replay"),
    target,
    conversationId: "original",
    sequence: 31,
  });
  await index.receive({
    ...delivery("replacement-replay"),
    target,
    conversationId: "replacement",
    sequence: 7,
  });
  await index.receive({
    ...delivery("replacement-next"),
    target,
    conversationId: "replacement",
    sequence: 8,
  });

  expect(notices).toHaveLength(1);
});

test("a late receipt writes its own scoped cursor without replacing the legacy slot", () => {
  const deltas: AgentConsumedSeqDelta[] = [];
  const { index } = attention({
    read: () => ({ targets: {}, aliases: {}, nextReadOrder: 1 }),
    write: () => {},
    apply: (_agentId, delta) => deltas.push(delta),
  });
  taskRead(index, "original", 30);
  index.bindConversation(agentId, target, "replacement");
  taskRead(index, "replacement", 5);
  taskRead(index, "original", 31);

  expect(deltas[1]?.upsertTargets).toMatchObject([
    { target, entry: { conversationId: "replacement", seq: 5 } },
  ]);
  expect(deltas[2]?.upsertTargets).toBeUndefined();
  expect(deltas[2]).toMatchObject({
    upsertScopedTargets: [{ target, entry: { conversationId: "original", seq: 31 } }],
  });
});

test("a malformed forwarded read boundary cannot consume a later delivery", async () => {
  const { index, notices } = attention();
  settleForwardedTaskRead(
    index,
    agentId,
    {},
    {
      consumptionScope: { agentId, conversationId: "original", channelType: "thread", target },
      messages: [],
      modelSeenUpToSeq: "31",
    },
  );

  await index.receive({
    ...delivery("after-invalid-receipt"),
    target,
    conversationId: "original",
    sequence: 6,
  });

  expect(notices).toHaveLength(1);
});

test.each([
  ["replacement", true],
  [undefined, false],
] as const)(
  "a task hold shows the read page and uses only its receipt for consumption (%s)",
  async (conversationId, consumed) => {
    const { index } = attention();
    taskRead(index, "replacement", 5);
    taskRead(index, "original", 31);
    await index.receive({
      ...delivery("replacement-pending"),
      target,
      conversationId: "replacement",
      sequence: 6,
      body: "Unpreviewed ".repeat(130),
    });

    const hold = await heldTaskResult(
      {
        messageAttention: index,
        workspaceId: "workspace-1",
        agentMessage: async ({ idempotencyKey }) => ({
          idempotencyKey,
          accepted: true,
          attentionCount: 1,
          messages: [messageRecord(6, "@ada", target)],
          ...(conversationId
            ? { consumptionScope: { agentId, conversationId, channelType: "thread", target } }
            : {}),
        }),
      },
      agentId,
      { operation: "claim", idempotencyKey: "held", target, number: 42 },
      target,
      "fixture-key",
    );

    expect(hold?.heldMessages?.map(({ sequence }) => sequence)).toEqual([6]);
    expect(index.hasSeen(agentId, target, 6, "replacement")).toBe(consumed);
    expect(index.modelSeenSequence(agentId, target, "original")).toBe(31);
  },
);

test("replaying an older conversation preserves both conversations' read frontiers", async () => {
  const { index, notices, acknowledgements } = attention();
  taskRead(index, "original", 31);
  taskRead(index, "replacement", 5);

  const original = {
    ...delivery("original-replay"),
    target,
    conversationId: "original",
    sequence: 31,
  };
  const replacement = {
    ...delivery("replacement-replay"),
    target,
    conversationId: "replacement",
    sequence: 5,
  };
  await index.receive(original);
  await index.receive(replacement);

  expect(acknowledgements).toEqual([original.deliveryId, replacement.deliveryId]);
  expect(notices).toEqual([]);
});

test("a late complete preview belongs to its queued delivery's conversation", async () => {
  const { index, notices } = attention();
  taskRead(index, "replacement", 5);
  const original = {
    ...delivery("original-preview", "human", "ada"),
    target,
    conversationId: "original",
    sequence: 6,
    body: "Old conversation preview",
    attachmentCount: 0,
  };
  const notice = buildNoticeRows({
    announced: [],
    queued: [original],
    agentId,
    previewLimit: 3,
    previewedInFull: () => false,
  });
  expect(notice.whole).toHaveLength(1);
  index.previewSeen.record(agentId, notice.whole);

  await index.receive({
    ...delivery("replacement-fresh", "human", "ada"),
    target,
    conversationId: "replacement",
    sequence: 6,
    body: "New conversation message",
  });

  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("New conversation message");
});

test("an empty task read settles only through its receipt when a newer delivery is pending", async () => {
  const { index } = attention();
  const message = {
    ...delivery("after-empty-read", "human", "ada"),
    target,
    conversationId: "original",
    sequence: 6,
    body: "Unpreviewed ".repeat(130),
  };
  await index.receive({
    ...message,
    messageId: "prior-message",
    deliveryId: "prior-delivery",
    sequence: 5,
  });
  await index.receive(message);
  expect(index.pendingWindow(agentId, target, 10).map((entry) => entry.delivery.sequence)).toEqual([
    5, 6,
  ]);

  taskRead(index, "original", 5);

  expect(index.pendingWindow(agentId, target, 10).map((entry) => entry.delivery.sequence)).toEqual([
    6,
  ]);
});

test("a late read of the original conversation leaves the replacement's pending delivery", async () => {
  const { index, notices } = attention();
  taskRead(index, "original", 30);
  taskRead(index, "replacement", 5);
  const replacement = {
    ...delivery("replacement-pending", "human", "ada"),
    target,
    conversationId: "replacement",
    sequence: 6,
  };
  await index.receive(replacement);

  taskRead(index, "original", 31);
  await index.receive({
    ...delivery("replacement-replayed", "human", "ada"),
    target,
    conversationId: "replacement",
    sequence: 5,
  });

  expect(notices).toHaveLength(1);
  expect(
    index.pendingWindow(agentId, target, 10).map(({ delivery }) => delivery.deliveryId),
  ).toEqual([replacement.deliveryId]);
});

test("a read receipt settles the matching conversation when both pending sequences are equal", async () => {
  const { index } = attention();
  for (const conversationId of ["original", "replacement"]) {
    await index.receive({ ...delivery(conversationId), conversationId, target, sequence: 5 });
  }

  taskRead(index, "original", 5);

  expect(index.pendingMessageCount(agentId, target)).toBe(1);
  expect(
    index.pendingWindow(agentId, target, 10).map(({ delivery }) => delivery.conversationId),
  ).toEqual(["replacement"]);
});

test("scoped persistence uses the server thread ID and skips a display-only root", () => {
  const displayed = "#team:01a21179";
  const threadRootId = "01a21179-7072-725a-9064-84d579ae07bd";
  const deltas: AgentConsumedSeqDelta[] = [];
  const { index } = attention({
    read: () => ({ targets: {}, aliases: {}, nextReadOrder: 1 }),
    write: () => {},
    apply: (_agentId, delta) => deltas.push(delta),
  });
  for (const root of [undefined, threadRootId]) {
    const scope = {
      agentId,
      conversationId: "channel-1",
      channelType: "thread" as const,
      target: displayed,
      threadRootId: root,
    };
    settleForwardedTaskRead(
      index,
      agentId,
      {},
      {
        consumptionScope: scope,
        messages: [],
        modelSeenUpToSeq: 7,
      },
    );
  }

  expect(deltas).toHaveLength(1);
  expect(deltas[0]).toMatchObject({
    upsertScopedTargets: [
      { target: displayed, threadRootId, entry: { conversationId: "channel-1", seq: 7 } },
    ],
  });
});

test("restoring a short thread spelling consumes only the matching replay", async () => {
  const target = "#team:01a21179-7072";
  const saved = {
    targets: {},
    aliases: {},
    nextReadOrder: 1,
    scopedTargets: [
      {
        target,
        threadRootId: "01a21179-7072-725a-9064-84d579ae07bd",
        entry: { conversationId: "channel-1", seq: 7 },
      },
    ],
  } satisfies AgentConsumedSeqState;
  const { index, notices } = attention({ read: () => saved, write: () => {} });
  for (const sequence of [7, 8]) {
    await index.receive({
      ...delivery(`thread-${sequence}`),
      target,
      conversationId: "channel-1",
      sequence,
    });
  }
  expect(notices).toHaveLength(1);
});

test("an unseen earlier read or write scope cannot replace the current rollback slot", () => {
  const deltas: AgentConsumedSeqDelta[] = [];
  const { index } = attention({
    read: () => ({ targets: {}, aliases: {}, nextReadOrder: 1 }),
    write: () => {},
    apply: (_agentId, delta) => deltas.push(delta),
  });
  index.bindConversation(agentId, target, "replacement");
  taskRead(index, "replacement", 7);
  taskRead(index, "original-read", 31);
  index.recordSendContext(agentId, target, 26, undefined, { conversationId: "original-write" });

  expect(deltas.map((delta) => delta.upsertTargets?.[0]?.entry.conversationId)).toEqual([
    "replacement",
    undefined,
    undefined,
  ]);
  expect(index.modelSeenSequence(agentId, target, "original-read")).toBe(31);
  expect(index.modelSeenSequence(agentId, target, "original-write")).toBe(26);
  expect(index.modelSeenSequence(agentId, target)).toBe(7);
});
