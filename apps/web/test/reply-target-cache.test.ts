import { expect, test } from "bun:test";

import { cachedReplyTargetResolver } from "#src/server/agents/reply-target-cache.server";

const call = { workspaceId: "w", agentId: "a", callId: "c1", target: "#general" };
const target = { conversationId: "conversation-1", threadRootId: null };

function subject(options: { ttlMs?: number; maxEntries?: number } = {}) {
  let now = 0;
  const reads: string[] = [];
  const resolve = cachedReplyTargetResolver(
    async ({ callId, target: wanted }) => {
      reads.push(`${callId}:${wanted}`);
      return wanted === "#nowhere" ? undefined : target;
    },
    { ttlMs: 30_000, maxEntries: 2, now: () => now, ...options },
  );
  return { resolve, reads, advance: (ms: number) => (now += ms) };
}

test("a call's repeats renew its target and an idle entry expires", async () => {
  const { resolve, reads, advance } = subject();
  expect(await resolve(call)).toEqual(target);
  advance(8_000);
  expect(await resolve(call)).toEqual(target);
  advance(29_999);
  await resolve(call);
  expect(reads).toHaveLength(1);
  advance(30_000);
  await resolve(call);
  expect(reads).toHaveLength(2);
});

test("a different call, target, Agent or Workspace is its own entry", async () => {
  const { resolve, reads } = subject({ maxEntries: 10 });
  await resolve(call);
  await resolve({ ...call, callId: "c2" });
  await resolve({ ...call, target: "#random" });
  await resolve({ ...call, agentId: "b" });
  await resolve({ ...call, workspaceId: "x" });
  expect(reads).toHaveLength(5);
});

test("only a target that resolved is remembered: nothing, and a failed read, are read again", async () => {
  const { resolve, reads } = subject();
  expect(await resolve({ ...call, target: "#nowhere" })).toBeUndefined();
  expect(await resolve({ ...call, target: "#nowhere" })).toBeUndefined();
  expect(reads).toHaveLength(2);

  let attempts = 0;
  const flaky = cachedReplyTargetResolver(async () => {
    if (++attempts === 1) throw new Error("database unavailable");
    return target;
  });
  await expect(flaky(call)).rejects.toThrow();
  expect(await flaky(call)).toEqual(target);
});

test("it holds a bounded number of entries and forgets the oldest", async () => {
  const { resolve, reads } = subject({ maxEntries: 2 });
  await resolve({ ...call, callId: "c1" });
  await resolve({ ...call, callId: "c2" });
  await resolve({ ...call, callId: "c3" });
  await resolve({ ...call, callId: "c3" });
  expect(reads).toHaveLength(3);
  await resolve({ ...call, callId: "c1" });
  expect(reads).toHaveLength(4);
});

test("a long call keeps its resolved conversation through repeated starts and a late end", async () => {
  const { resolve, reads, advance } = subject();
  expect(await resolve(call)).toEqual(target);
  for (let repeat = 0; repeat < 8; repeat++) {
    advance(8_000);
    expect(await resolve(call)).toEqual(target);
  }
  advance(8_000);
  expect(await resolve(call)).toEqual(target);
  expect(reads).toEqual(["c1:#general"]);
});
