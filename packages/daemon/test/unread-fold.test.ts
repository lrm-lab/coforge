import { expect, test } from "bun:test";
import { foldShownMessages } from "#src/daemon-runtime/unread-fold";

const shownSequences = new Set([4, 5, 7]);
const attention = {
  resolveTarget: (_agentId: string, target: string) => target,
  hasSeen: (_agentId: string, _target: string, sequence: number) => shownSequences.has(sequence),
};
const page = (...sequences: number[]) =>
  sequences.map((sequence) => ({ target: "#general", sequence }));

test("an unread page keeps what the Agent was not shown and summarizes what it was", () => {
  const { messages, folded } = foldShownMessages(
    attention,
    "agent",
    "#general",
    page(4, 5, 6, 7, 8),
  );
  expect(messages.map((message) => message.sequence)).toEqual([6, 8]);
  expect(folded).toEqual({ count: 3, fromSequence: 4, throughSequence: 7 });
});

test("an unread page of only shown messages folds all of them", () => {
  const { messages, folded } = foldShownMessages(attention, "agent", "#general", page(4, 5));
  expect(messages).toEqual([]);
  expect(folded).toEqual({ count: 2, fromSequence: 4, throughSequence: 5 });
});

test("an unread page the Agent was shown none of folds nothing", () => {
  const { messages, folded } = foldShownMessages(attention, "agent", "#general", page(1, 2, 3));
  expect(messages.map((message) => message.sequence)).toEqual([1, 2, 3]);
  expect(folded).toBeUndefined();
});

test("a message of another target is never folded", () => {
  const { messages, folded } = foldShownMessages(attention, "agent", "#general", [
    { target: "#general:abc", sequence: 4 },
  ]);
  expect(messages).toHaveLength(1);
  expect(folded).toBeUndefined();
});
