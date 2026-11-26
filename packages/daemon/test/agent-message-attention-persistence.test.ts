import { afterEach, expect, test } from "bun:test";
import { AgentConsumedSeqStore } from "#src/persistence/agent-consumed-seq-store";
import { delivery } from "./fixtures/attention-delivery";
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
  bindTargets(first, "@agent", "#general");
  first.recordExactSeen(
    "agent-1",
    new Map([
      ["@agent", [8, 6]],
      ["#general", [2]],
    ]),
  );
  first.recordModelSeen("agent-1", "@agent", 6);
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
