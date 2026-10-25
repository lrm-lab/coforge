import { expect, test } from "bun:test";
import type { MessageAttention } from "#src/daemon-runtime/agent-message-attention-index";
import { attentionFlags, latestCreatedAtField } from "#src/daemon-runtime/message-attention-fields";

const previous = (latestCreatedAtMs?: number): MessageAttention => ({
  target: "#general",
  pendingCount: 1,
  firstPendingSequence: 1,
  latestSequence: 1,
  ...(latestCreatedAtMs === undefined ? {} : { latestCreatedAtMs }),
  flags: ["channel", "non_member_mention"],
});

test("the newest creation time wins, whatever order the messages arrive in", () => {
  expect(latestCreatedAtField(previous(200), 100)).toEqual({ latestCreatedAtMs: 200 });
  expect(latestCreatedAtField(previous(100), 200)).toEqual({ latestCreatedAtMs: 200 });
  expect(latestCreatedAtField(undefined, 100)).toEqual({ latestCreatedAtMs: 100 });
});

test("a server that sends no creation time leaves it unset", () => {
  expect(latestCreatedAtField(previous(), undefined)).toEqual({});
  expect(latestCreatedAtField(undefined, undefined)).toEqual({});
  expect(latestCreatedAtField(previous(100), undefined)).toEqual({ latestCreatedAtMs: 100 });
});

test("a target keeps its non-member flag once any pending message set it", () => {
  expect(attentionFlags("#general", undefined, previous())).toEqual([
    "channel",
    "non_member_mention",
  ]);
  expect(attentionFlags("@ada", undefined, undefined)).toEqual(["dm"]);
  expect(attentionFlags("#general:abc", true, undefined)).toEqual(["thread", "non_member_mention"]);
});
