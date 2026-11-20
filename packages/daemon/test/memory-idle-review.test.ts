import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import { MemoryReviewLedger } from "#src/persistence/memory-review-ledger";
import {
  humanMemoryActivityTime,
  MemoryIdleReview,
  MEMORY_REVIEW_INTERVAL_MS,
} from "#src/daemon-runtime/memory-idle-review";
const roots: string[] = [];
const databases: AgentStateDb[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "memory-idle-review-"));
  roots.push(root);
  const db = AgentStateDb.open(root, "agent");
  databases.push(db);
  const ledger = new MemoryReviewLedger(db.database);
  let now = MEMORY_REVIEW_INTERVAL_MS;
  let idle = true;
  const prompts: string[] = [];
  let receipt: { batchId: string; reviewed: string[] } | undefined;
  const review = new MemoryIdleReview({
    ledger: () => ledger,
    idle: () => idle,
    now: () => now,
    schedule: () => () => {},
    receipt: async () => receipt,
    deliver: async (_id, prompt) => {
      prompts.push(prompt);
      return true;
    },
  });
  return {
    root,
    ledger,
    review,
    prompts,
    advance: () => {
      now += MEMORY_REVIEW_INTERVAL_MS;
    },
    busy: (value: boolean) => {
      idle = !value;
    },
    receipt: (value: typeof receipt) => {
      receipt = value;
    },
  };
}
test("new human activity and changed memory are both required; review writes cannot loop", async () => {
  const h = await setup();
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(0);
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.busy(true);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(0);
  h.busy(false);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
  const batch = h.ledger.state().active!;
  h.review.noteWrite("agent", "lesson", "tidied");
  h.receipt({ batchId: batch.id, reviewed: ["lesson"] });
  await h.review.inspect("agent");
  h.advance();
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
  expect(h.ledger.pending()).toEqual([]);
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS + 100);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
});
test("five per batch, partial acknowledgement and cooldown survive reopening the ledger", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  for (let i = 0; i < 7; i++) h.review.noteWrite("agent", `key${i}`, "one");
  await h.review.inspect("agent");
  const batch = h.ledger.state().active!;
  expect(batch.entries).toHaveLength(5);
  h.receipt({ batchId: batch.id, reviewed: ["key0", "key1", "not-in-batch"] });
  await h.review.inspect("agent");
  const reopened = AgentStateDb.open(h.root, "agent");
  databases.push(reopened);
  const ledger = new MemoryReviewLedger(reopened.database);
  expect(ledger.pending().map((entry) => entry.key)).toEqual([
    "key2",
    "key3",
    "key4",
    "key5",
    "key6",
  ]);
  expect(ledger.state().usedHumanAt).toBe(MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS + 100);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
  h.advance();
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(2);
});
test("human corrections made during review survive an old acknowledgement", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  const batch = h.ledger.state().active!;
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS + 100);
  h.review.noteWrite("agent", "lesson", "human-correction");
  h.receipt({ batchId: batch.id, reviewed: ["lesson"] });
  await h.review.inspect("agent");
  expect(h.ledger.pending()).toEqual([{ key: "lesson", revision: "human-correction" }]);
});
test("missing or stale receipts keep work; replayed human messages never rearm it", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  h.receipt({ batchId: "stale", reviewed: ["lesson"] });
  await h.review.inspect("agent");
  expect(h.ledger.pending()).toHaveLength(1);
  h.advance();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
});

test("typed system, agent and ambient channel deliveries cannot qualify as human interaction", async () => {
  const h = await setup();
  h.review.noteWrite("agent", "lesson", "one");
  const base = {
    agentId: "agent",
    createdAtMs: MEMORY_REVIEW_INTERVAL_MS - 100,
    target: "@person",
  };
  const observe = (message: Parameters<typeof humanMemoryActivityTime>[0]) => {
    const time = humanMemoryActivityTime(message);
    if (time !== undefined) h.review.noteHuman("agent", time);
  };
  for (const message of [
    { ...base, latestSenderKind: "system" },
    { ...base, latestSenderKind: "agent" },
    { ...base, latestSenderKind: "human", source: "app" },
    { ...base, latestSenderKind: "human", target: "#general" },
    { ...base, latestSenderKind: "human", createdAtMs: undefined },
  ])
    observe(message as Parameters<typeof humanMemoryActivityTime>[0]);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(0);
  observe({ ...base, latestSenderKind: "human" } as Parameters<typeof observe>[0]);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
});

test("human work arriving while a receipt is read prevents review admission", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  h.advance();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS + 100);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<undefined>();
  let idle = true;
  let deliveries = 0;
  const review = new MemoryIdleReview({
    ledger: () => h.ledger,
    idle: () => idle,
    now: () => 3 * MEMORY_REVIEW_INTERVAL_MS,
    schedule: () => () => {},
    receipt: () => {
      entered.resolve();
      return release.promise;
    },
    deliver: async () => {
      deliveries++;
      return true;
    },
  });
  const inspection = review.inspect("agent");
  await entered.promise;
  idle = false;
  release.resolve(undefined);
  await inspection;
  expect(deliveries).toBe(0);
  expect(h.ledger.state().usedHumanAt).toBe(MEMORY_REVIEW_INTERVAL_MS - 100);
});

test("stopping while a receipt is read cancels the old generation without reopening state", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<undefined>();
  let scheduled = 0;
  const review = new MemoryIdleReview({
    ledger: () => h.ledger,
    idle: () => true,
    schedule: () => {
      scheduled++;
      return () => {};
    },
    receipt: () => {
      entered.resolve();
      return release.promise;
    },
    deliver: async () => {
      throw new Error("must not deliver");
    },
  });
  const inspection = review.inspect("agent");
  await entered.promise;
  review.clear();
  release.resolve(undefined);
  await inspection;
  expect(scheduled).toBe(0);
  expect(h.ledger.state().active).toBeDefined();
});

test("unknown notification outcome spends the cooldown without losing the pending batch", async () => {
  const h = await setup();
  let calls = 0;
  let now = MEMORY_REVIEW_INTERVAL_MS;
  const review = new MemoryIdleReview({
    ledger: () => h.ledger,
    idle: () => true,
    now: () => now,
    schedule: () => () => {},
    receipt: async () => undefined,
    deliver: async () => {
      calls++;
      throw new Error("connection closed after send");
    },
  });
  review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  review.noteWrite("agent", "lesson", "one");
  await review.inspect("agent");
  await review.inspect("agent");
  now += MEMORY_REVIEW_INTERVAL_MS;
  await review.inspect("agent");
  expect(calls).toBe(1);
  expect(h.ledger.pending()).toEqual([{ key: "lesson", revision: "one" }]);
});

test("unrelated writes during a review remain pending for a later human-qualified batch", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  h.review.noteWrite("agent", "other", "new");
  const batch = h.ledger.state().active!;
  h.receipt({ batchId: batch.id, reviewed: ["lesson"] });
  await h.review.inspect("agent");
  expect(h.ledger.pending()).toEqual([{ key: "other", revision: "new" }]);
});

test("a delayed historical human message cannot rearm a review after its start", async () => {
  const h = await setup();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 100);
  h.review.noteWrite("agent", "lesson", "one");
  await h.review.inspect("agent");
  await h.review.inspect("agent");
  h.advance();
  h.review.noteHuman("agent", MEMORY_REVIEW_INTERVAL_MS - 50);
  await h.review.inspect("agent");
  expect(h.prompts).toHaveLength(1);
});
