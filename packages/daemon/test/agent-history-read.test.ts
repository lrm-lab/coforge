import { expect, test } from "bun:test";
import { settleHistoryRead } from "#src/daemon-runtime/agent-history-read";
import type { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";

function attentionStub() {
  const calls: string[] = [];
  const attention = {
    resolveTarget: (_agent: string, target: string) => target,
    hasSeen: () => false,
    recordHistoryRead: () => calls.push("record"),
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
  expect(calls).toEqual(["record", "clear 80"]);
});

test("an empty unread page with more unread behind it keeps the attention it did not show", () => {
  const { attention, calls } = attentionStub();
  settleHistoryRead(attention, "agent", "#general", read({ moreUnread: true }));
  expect(calls).toEqual(["record"]);
});
