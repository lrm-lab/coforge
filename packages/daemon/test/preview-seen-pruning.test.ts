import { expect, test } from "bun:test";
import { SEEN_EXACT_SEQS_LIMIT } from "@lrm/coforge-sdk/internal";
import { AgentConsumedAttention } from "#src/daemon-runtime/agent-consumed-attention";
import { PreviewSeen } from "#src/daemon-runtime/inbox-preview-rows";

test("PreviewSeen prunes consumed sequences through the frontier and drops empty buckets", () => {
  const seen = new PreviewSeen();
  seen.record("agent-a", [
    { target: "#general", sequence: 3 },
    { target: "#general", sequence: 5 },
    { target: "#general", sequence: 8 },
  ]);
  seen.pruneThrough("agent-a", "#general", 5);
  expect([...(seen.recorded("agent-a", "#general") ?? [])]).toEqual([8]);

  seen.pruneThrough("agent-a", "#general", 8);
  expect(seen.recorded("agent-a", "#general")).toBeUndefined();
});

test("PreviewSeen bounds per-target entries to SEEN_EXACT_SEQS_LIMIT keeping the newest sequences", () => {
  const seen = new PreviewSeen();
  const batch = Array.from({ length: SEEN_EXACT_SEQS_LIMIT + 25 }, (_, i) => ({
    target: "#general",
    sequence: i + 1,
  }));
  seen.record("agent-a", batch);
  const kept = [...(seen.recorded("agent-a", "#general") ?? [])].sort((a, b) => a - b);
  expect(kept).toHaveLength(SEEN_EXACT_SEQS_LIMIT);
  expect(kept[0]).toBe(26);
  expect(kept.at(-1)).toBe(SEEN_EXACT_SEQS_LIMIT + 25);
});

test("AgentConsumedAttention prunes PreviewSeen on frontier advance and clears it on recreated conversations", () => {
  const previewSeen = new PreviewSeen();
  const attention = new AgentConsumedAttention({
    store: () => undefined,
    previewSeen,
    settlePending: () => undefined,
  });
  attention.bindConversation("agent-a", "#general", "conv-1");
  previewSeen.record("agent-a", [
    { target: "#general", sequence: 10 },
    { target: "#general", sequence: 12 },
  ]);
  expect(attention.hasExactSeen("agent-a", "#general")).toBe(true);

  attention.recordModelSeen("agent-a", "#general", 10);
  expect(attention.seenExactSequences("agent-a", "#general")).toEqual([12]);

  attention.recordModelSeen("agent-a", "#general", 12);
  expect(attention.hasExactSeen("agent-a", "#general")).toBe(false);
  expect(attention.seenExactSequences("agent-a", "#general")).toEqual([]);
  expect(previewSeen.recorded("agent-a", "#general")).toBeUndefined();

  previewSeen.record("agent-a", [{ target: "#general", sequence: 20 }]);
  attention.bindConversation("agent-a", "#general", "conv-2");
  expect(previewSeen.recorded("agent-a", "#general")).toBeUndefined();
  expect(attention.hasExactSeen("agent-a", "#general")).toBe(false);
});

test("planDeliveryNotice skips non-card deliveries already covered by the consumed frontier after PreviewSeen pruning while keeping card events", async () => {
  const { AGENT_MESSAGE_METHOD } = await import("@lrm/coforge-sdk/internal");
  const { planDeliveryNotice } = await import("#src/daemon-runtime/delivery-notice");
  const { noticeEligibility } = await import("#src/daemon-runtime/notice-eligibility");
  const previewSeen = new PreviewSeen();
  const attention = new AgentConsumedAttention({
    store: () => undefined,
    previewSeen,
    settlePending: () => undefined,
  });
  attention.bindConversation("agent-a", "#alpha", "conv-alpha");
  attention.bindConversation("agent-a", "#beta", "conv-beta");

  const d1 = {
    protocolMajor: 1 as const,
    requestId: "req-1",
    messageId: "msg-alpha-5",
    deliveryId: "del-1",
    sequence: 5,
    workspaceId: "ws-1",
    conversationId: "conv-alpha",
    agentId: "agent-a",
    target: "#alpha",
    body: "short",
    latestSenderKind: "human" as const,
    latestSenderHandle: "frank",
    attachmentCount: 0,
    method: AGENT_MESSAGE_METHOD,
  };
  const d2 = {
    ...d1,
    requestId: "req-2",
    messageId: "msg-beta-20",
    deliveryId: "del-2",
    sequence: 20,
    conversationId: "conv-beta",
    target: "#beta",
    body: "still unread",
  };
  const cardAnswer = {
    ...d1,
    requestId: "req-3",
    messageId: "msg-alpha-card",
    deliveryId: "del-3",
    sequence: 5,
    reason: "choice",
  };

  previewSeen.record("agent-a", [{ target: "#alpha", sequence: 5 }]);
  attention.recordModelSeen("agent-a", "#alpha", 5);
  expect(previewSeen.recorded("agent-a", "#alpha")).toBeUndefined();

  const retryNotice = planDeliveryNotice({
    agentId: "agent-a",
    announced: [d1, d2],
    queued: [],
    prefix: "",
    previewedInFull: (target, sequence) => previewSeen.has("agent-a", target, sequence),
    eligibility: noticeEligibility((...args) => attention.readBasis(...args)),
  })();
  expect(retryNotice?.rows).toHaveLength(1);
  expect(retryNotice?.rows[0]).toStartWith("#beta ");
  expect(retryNotice?.shown).toEqual([{ target: "#beta", sequence: 20 }]);

  const cardNotice = planDeliveryNotice({
    agentId: "agent-a",
    announced: [cardAnswer],
    queued: [],
    prefix: "",
    previewedInFull: (target, sequence) => previewSeen.has("agent-a", target, sequence),
    eligibility: noticeEligibility((...args) => attention.readBasis(...args)),
  })();
  expect(cardNotice?.rows).toHaveLength(1);
  expect(cardNotice?.rows[0]).toStartWith("#alpha ");
});
