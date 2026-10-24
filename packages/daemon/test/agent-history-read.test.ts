import { expect, test } from "bun:test";
import { settleHistoryRead } from "#src/daemon-runtime/agent-history-read";
import type { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";

function attentionStub() {
  const calls: string[] = [];
  const attention = {
    resolveTarget: (_agent: string, target: string) => target,
    hasSeen: () => false,
    recordHistoryRead: (_agent: string, record: { review?: { sequence: number } }) =>
      calls.push(record.review ? `record review ${record.review.sequence}` : "record"),
    clearThrough: (_agent: string, _target: string, through: number) =>
      calls.push(`clear ${through}`),
  } as unknown as AgentMessageAttentionIndex;
  return { attention, calls };
}

const read = (result: object) =>
  ({
    request: { unread: true },
    result: { messages: [], ...result },
    unpaged: true,
    attentionUpperBound: 80,
  }) as never;

test("an empty unread page clears the attention it covered", () => {
  const { attention, calls } = attentionStub();
  settleHistoryRead(attention, "agent", "#general", read({ moreUnread: false }));
  expect(calls).toEqual(["record review 0", "clear 80"]);
});

test("an empty unread page with more unread behind it keeps the attention it did not show", () => {
  const { attention, calls } = attentionStub();
  settleHistoryRead(attention, "agent", "#general", read({ moreUnread: true }));
  expect(calls).toEqual(["record review 0"]);
});

const plainRead = (messages: object[]) =>
  ({
    request: {},
    result: { messages, modelSeenUpToSeq: null },
    unpaged: true,
    attentionUpperBound: undefined,
  }) as never;

test("the newest page of a read without an anchor reviews the target and clears no attention", () => {
  const { attention, calls } = attentionStub();
  settleHistoryRead(
    attention,
    "agent",
    "#general",
    plainRead([{ sequence: 7, target: "#general" }]),
  );
  expect(calls).toEqual(["record review 7"]);
});

test("an empty newest page clears no attention either", () => {
  const { attention, calls } = attentionStub();
  settleHistoryRead(attention, "agent", "#general", plainRead([]));
  expect(calls).toEqual(["record review 0"]);
});

test("a page before an anchor reviews nothing", () => {
  const { attention, calls } = attentionStub();
  settleHistoryRead(attention, "agent", "#general", {
    request: { before: "x" },
    result: { messages: [{ sequence: 7, target: "#general" }], modelSeenUpToSeq: null },
    unpaged: false,
    attentionUpperBound: undefined,
  } as never);
  expect(calls).toEqual(["record"]);
});
