import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import {
  AgentContinuationStore,
  AGENT_CONTINUATION_TTL_MS,
  type AgentContinuation,
} from "#src/persistence/agent-continuation-store";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const storeFor = (
  root: string,
  agentId = "agent-a",
  now: () => number = () => 1_000,
): AgentContinuationStore => new AgentContinuationStore(AgentStateDb.open(root, agentId), now);

const continuation = (over: Partial<AgentContinuation> = {}): AgentContinuation => ({
  id: "cont-1",
  target: "#general",
  draft: { content: "held body", idempotencyKey: "key-1", reholdCount: 1 },
  anywayOffered: true,
  createdAt: 1_000,
  expiresAt: 1_000 + AGENT_CONTINUATION_TTL_MS,
  ...over,
});

test("creates, looks up, and answers one continuation", async () => {
  const root = join(tmpdir(), `coforge-cont-${crypto.randomUUID()}`);
  directories.push(root);
  const store = storeFor(root);
  await store.create(continuation());
  expect(await store.lookup("cont-1")).toEqual({
    status: "open",
    continuation: continuation(),
  });
  expect(
    await store.markAnswered("cont-1", { choice: "a", withInput: false, answeredAt: 2_000 }),
  ).toBe(true);
  expect(await store.lookup("cont-1")).toEqual({
    status: "answered",
    continuation: continuation(),
    answer: { choice: "a", withInput: false, answeredAt: 2_000 },
  });
});

test("a second answer loses: only the first is recorded", async () => {
  const root = join(tmpdir(), `coforge-cont-${crypto.randomUUID()}`);
  directories.push(root);
  const store = storeFor(root);
  await store.create(continuation());
  expect(
    await store.markAnswered("cont-1", { choice: "b", withInput: true, answeredAt: 2_000 }),
  ).toBe(true);
  expect(
    await store.markAnswered("cont-1", { choice: "c", withInput: false, answeredAt: 3_000 }),
  ).toBe(false);
  expect(await store.lookup("cont-1")).toMatchObject({
    status: "answered",
    answer: { choice: "b", withInput: true },
  });
});

test("a missing id looks up missing; an expired open row reports expired once", async () => {
  const root = join(tmpdir(), `coforge-cont-${crypto.randomUUID()}`);
  directories.push(root);
  let now = 1_000;
  const store = storeFor(root, "agent-a", () => now);
  expect(await store.lookup("nope")).toEqual({ status: "missing" });
  await store.create(continuation({ expiresAt: 1_000 + AGENT_CONTINUATION_TTL_MS }));
  now = 1_000 + AGENT_CONTINUATION_TTL_MS;
  expect(await store.lookup("cont-1")).toMatchObject({ status: "expired" });
  expect(await store.lookup("cont-1")).toEqual({ status: "missing" });
});

test("a new continuation for the same target supersedes the open one", async () => {
  const root = join(tmpdir(), `coforge-cont-${crypto.randomUUID()}`);
  directories.push(root);
  const store = storeFor(root);
  await store.create(continuation());
  await store.create(continuation({ id: "cont-2" }));
  expect(await store.lookup("cont-1")).toEqual({ status: "missing" });
  expect(await store.lookup("cont-2")).toMatchObject({ status: "open" });
});

test("an answered tombstone survives supersede until expiry", async () => {
  const root = join(tmpdir(), `coforge-cont-${crypto.randomUUID()}`);
  directories.push(root);
  let now = 1_000;
  const store = storeFor(root, "agent-a", () => now);
  await store.create(continuation({ expiresAt: 1_000 + AGENT_CONTINUATION_TTL_MS }));
  await store.markAnswered("cont-1", { choice: "c", withInput: false, answeredAt: 2_000 });
  await store.create(continuation({ id: "cont-2", expiresAt: 1_000 + AGENT_CONTINUATION_TTL_MS }));
  expect(await store.lookup("cont-1")).toMatchObject({
    status: "answered",
    answer: { choice: "c" },
  });
  now = 1_000 + AGENT_CONTINUATION_TTL_MS;
  await store.create(continuation({ id: "cont-3", expiresAt: now + AGENT_CONTINUATION_TTL_MS }));
  expect(await store.lookup("cont-1")).toEqual({ status: "missing" });
});
