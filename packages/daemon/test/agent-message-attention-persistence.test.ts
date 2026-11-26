import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { afterEach, expect, test } from "bun:test";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { delivery, session } from "./fixtures/attention-delivery";
import {
  bindTargets,
  clearAttentionStateDirectories,
  indexWithConsumedSeqs,
  temporaryStateDirectory,
} from "./fixtures/attention-persistence";

afterEach(clearAttentionStateDirectories);

test("exact sequences survive a restart and a frontier that reaches them prunes them", () => {
  const store = new AgentConsumedSeqStore(temporaryStateDirectory());
  const first = indexWithConsumedSeqs(store);
  first.recordHistoryRead("agent-1", {
    spelling: "@agent",
    target: "@agent",
    scope: { target: "@agent", conversationId: "conversation-1", channelType: "dm" },
    shown: [6, 8],
    through: 6,
  });
  first.recordHistoryRead("agent-1", {
    spelling: "#general",
    target: "#general",
    scope: { target: "#general", conversationId: "channel-conversation", channelType: "dm" },
    shown: [2],
    through: 0,
  });
  expect(first.seenExactSequences("agent-1", "@agent")).toEqual([8]);
  const restarted = indexWithConsumedSeqs(store);
  expect(restarted.seenExactSequences("agent-1", "@agent")).toEqual([8]);
  expect(restarted.seenExactSequences("agent-1", "#general")).toEqual([2]);
  expect(restarted.hasConsumed({ ...delivery("eight"), sequence: 8 })).toBe(true);
  expect(restarted.hasConsumed({ ...delivery("seven"), sequence: 7 })).toBe(false);
});
test("an alias spelling shares its target's consumed state, across a restart", () => {
  const store = new AgentConsumedSeqStore(temporaryStateDirectory());
  const index = indexWithConsumedSeqs(store);
  bindTargets(index, "@agent");
  index.recordTargetAlias("agent-1", "@Agent", "@agent");
  index.recordExactSeen("agent-1", new Map([["@agent", [4]]]));
  expect(index.resolveTarget("agent-1", "@Agent")).toBe("@agent");
  expect(index.resolveTarget("agent-1", "@bea")).toBe("@bea");
  const restarted = indexWithConsumedSeqs(store);
  const canonical = restarted.resolveTarget("agent-1", "@Agent");
  expect(canonical).toBe("@agent");
  expect(restarted.hasSeen("agent-1", canonical, 4)).toBe(true);
});
test("an alias of an alias names the canonical target directly", () => {
  const store = new AgentConsumedSeqStore(temporaryStateDirectory());
  const index = indexWithConsumedSeqs(store);
  index.recordTargetAlias("agent-1", "a", "b");
  index.recordTargetAlias("agent-1", "b", "c");
  index.recordTargetAlias("agent-1", "z", "a");
  for (const spelling of ["a", "b", "z"])
    expect(index.resolveTarget("agent-1", spelling)).toBe("c");
  expect(store.read("agent-1").aliases).toEqual({ a: "c", b: "c", z: "c" });
});

test("clearing through a read boundary preserves concurrently newer attention", async () => {
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session(() => undefined) },
    async () => undefined,
  );
  await index.receive({ ...delivery("old"), sequence: 7 });
  await index.receive({ ...delivery("new"), deliveryId: "delivery-new", sequence: 8 });
  index.recordModelSeen("agent-1", "@agent", 7);
  expect(index.check("agent-1")).toMatchObject([
    { pendingCount: 1, firstPendingSequence: 8, latestSequence: 8 },
  ]);
});

test("a history read records its alias, frontier, exact sequences and read order in one write", () => {
  const writes: unknown[] = [];
  const store = new AgentConsumedSeqStore(temporaryStateDirectory());
  const counting = {
    read: (agentId: string) => store.read(agentId),
    write: (agentId: string, state: Parameters<AgentConsumedSeqStore["write"]>[1]) => {
      writes.push(state);
      store.write(agentId, state);
    },
  };
  const index = new AgentMessageAttentionIndex(
    "workspace-1",
    { session: () => session() },
    async () => {},
    () => {},
    { shouldHold: () => false, enqueue: () => {}, busy: () => {}, consumedSeqs: counting },
  );
  bindTargets(index, "@agent");
  writes.length = 0;
  index.recordHistoryRead("agent-1", {
    spelling: "@Agent",
    target: "@agent",
    shown: [3, 4, 6, 9],
    through: 4,
    review: { sequence: 9 },
  });
  expect(writes).toHaveLength(1);
  expect(store.read("agent-1")).toEqual({
    targets: {
      "@agent": {
        conversationId: "conversation-1",
        seq: 4,
        readOrder: 1,
        reviewedSeq: 9,
        exactSeqs: [6, 9],
      },
    },
    aliases: { "@Agent": "@agent" },
    nextReadOrder: 2,
    scopedTargets: [],
  });
});
