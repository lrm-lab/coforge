import { expect, test } from "bun:test";
import type { MemoryDispositionRecord } from "@lrm/coforge-sdk/agent";
import {
  createMemoryDispositions,
  type DeliveredMemoryHint,
  type MemoryDispositionStore,
} from "./memory-dispositions.server";

function fixture() {
  let clock = new Date("2026-10-15T03:00:00Z");
  let memoryAgent = false;
  const unreadable = new Set<string>();
  const sources = ["a", "b"].map((citationId) => ({
    citationId,
    accountId: "account",
    uri: `viking://resources/${citationId}`,
  }));
  const hint: DeliveredMemoryHint = {
    id: "hint",
    targetAgentId: "task",
    deliveredAt: clock,
    expiresAt: new Date("2026-10-15T03:05:00Z"),
    sources,
  };
  const events: MemoryDispositionRecord[] = [];
  const citations: { decision: string; source: string }[] = [];
  let aclReads = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const store: MemoryDispositionStore = {
    withHint(workspaceId, hintId, action) {
      const result = tail.then(() =>
        action({
          hint: workspaceId === "workspace" && hintId === hint.id ? hint : null,
          latest: events.at(-1) ?? null,
          async append(record, readable) {
            events.push(record);
            citations.push(
              ...readable.map((source) => ({
                decision: record.decision,
                source: source.citationId,
              })),
            );
          },
        }),
      );
      tail = result.catch(() => {});
      return result;
    },
  };
  const service = createMemoryDispositions({
    store,
    now: () => clock,
    async isMemoryAgent() {
      return memoryAgent;
    },
    async canReadSource(_workspace, _agent, source) {
      aclReads++;
      return !unreadable.has(source.citationId);
    },
  });
  const submit = (decision: string, reason = "appropriate", extra = {}) =>
    service.submit("workspace", "task", { hint_id: "hint", decision, reason, ...extra });
  return {
    service,
    submit,
    hint,
    events,
    citations,
    unreadable,
    sources,
    expire() {
      clock = new Date("2026-10-15T03:05:00Z");
    },
    memory() {
      memoryAgent = true;
    },
    aclReads: () => aclReads,
  };
}

test("authenticated target records intent and one citation per readable frozen source", async () => {
  const f = fixture();
  expect(
    await f.submit("adopt", "will verify", { intended_action_refs: ["planned-search"] }),
  ).toEqual({
    ok: true,
    duplicate: false,
    record: {
      hint_id: "hint",
      target_agent_id: "task",
      decision: "adopt",
      reason: "will verify",
      intended_action_refs: ["planned-search"],
      decided_at: "2026-10-15T03:00:00.000Z",
      skipped_source_refs: [],
    },
  });
  expect(f.citations).toEqual([
    { decision: "adopt", source: "a" },
    { decision: "adopt", source: "b" },
  ]);
});

test("defer can transition once, appending history; terminal decisions cannot flip", async () => {
  const f = fixture();
  await f.submit("defer");
  await f.submit("reject", "not applicable");
  expect(f.events.map((event) => event.decision)).toEqual(["defer", "reject"]);
  expect(await f.submit("adopt")).toEqual({ ok: false, error: { code: "terminal" } });
});

test("replay returns the saved record even after expiry and permission revocation", async () => {
  const f = fixture();
  const first = await f.submit("defer");
  f.expire();
  f.unreadable.add("a");
  f.unreadable.add("b");
  if (!first.ok) throw new Error("defer failed");
  expect(await f.submit("defer", "")).toEqual({ ...first, duplicate: true });
  expect(f.events).toHaveLength(1);
  expect(f.aclReads()).toBe(2);
  expect(await f.submit("adopt")).toEqual({ ok: false, error: { code: "expired" } });
});

test("unknown, another target, undelivered, and cross-workspace hints are opaque", async () => {
  const f = fixture();
  const request = { hint_id: "hint", decision: "adopt", reason: "" };
  const expected = { ok: false, error: { code: "unauthorized" } } as const;
  expect(await f.service.submit("workspace", "other", request)).toEqual(expected);
  expect(await f.service.submit("other", "task", request)).toEqual(expected);
  expect(await f.service.submit("workspace", "task", { ...request, hint_id: "unknown" })).toEqual(
    expected,
  );
  f.hint.deliveredAt = null;
  expect(await f.submit("adopt")).toEqual(expected);
  expect(f.aclReads()).toBe(0);
  expect(f.events).toHaveLength(0);
});

test("shape validation precedes caller lookup; callers cannot supply authority fields", async () => {
  const f = fixture();
  for (const value of [
    {},
    { hint_id: "hint", decision: "yes" },
    { hint_id: "hint", decision: "adopt", target_agent_id: "task" },
  ])
    expect(await f.service.submit("workspace", "other", value)).toEqual({
      ok: false,
      error: { code: "invalid_argument" },
    });
  f.memory();
  expect(await f.submit("adopt")).toEqual({ ok: false, error: { code: "unauthorized" } });
});

test("empty reason checks no source ACL and consumes no defer replacement", async () => {
  const f = fixture();
  await f.submit("defer");
  const reads = f.aclReads();
  f.unreadable.add("a");
  f.unreadable.add("b");
  expect(await f.submit("adopt", "  ")).toEqual({ ok: false, error: { code: "invalid_argument" } });
  expect(f.aclReads()).toBe(reads);
  expect(f.events).toHaveLength(1);
  expect(await f.submit("adopt")).toEqual({
    ok: false,
    error: { code: "not_actionable", source_refs: ["a", "b"] },
  });
  f.unreadable.delete("b");
  const result = await f.submit("adopt");
  expect(result.ok && result.record.skipped_source_refs).toEqual(["a"]);
  expect(f.events).toHaveLength(2);
});

test("concurrent conflicting decisions produce only one terminal event", async () => {
  const f = fixture();
  const results = await Promise.all([f.submit("adopt"), f.submit("reject")]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(f.events).toHaveLength(1);
});
