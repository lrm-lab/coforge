import { expect, test } from "bun:test";
import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { formatReadWindow } from "#src/message-read-format";

function message(sequence: number): AgentMessageRecord {
  return {
    id: `aaaaaaaa-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sequence,
    senderKind: "human",
    senderHandle: "ada",
    senderDescription: "",
    target: "#general",
    body: `message ${sequence}`,
    createdAt: "2026-09-07T10:00:00Z",
    attachments: [],
  };
}

const unread = { unread: true };

test("an unread read of one message names its seq and moves the read position", () => {
  const output = formatReadWindow(
    "#general",
    { messages: [message(6)], unreadCursorBefore: 3, readPositionAfter: 6 },
    unread,
  );
  const lines = output.split("\n");
  expect(lines[0]).toBe(
    "Unread window: 1 returned, seq 6, oldest to newest, starting after your read position (seq 3).",
  );
  expect(lines[1]).toStartWith("Coverage: top-level messages");
  expect(output).toContain(
    `Read position: seq 3 → 6. To re-read these: coforge message read --target "#general" --after 3`,
  );
  expect(output.endsWith("No more unread in this target.")).toBe(true);
});

test("an unread read of several messages counts only the ones shown", () => {
  const output = formatReadWindow(
    "#general",
    {
      messages: [message(6), message(8)],
      unreadCursorBefore: 3,
      readPositionAfter: 8,
      foldedMessageCount: 3,
      foldedFromSequence: 4,
      foldedThroughSequence: 7,
    },
    unread,
  );
  const lines = output.split("\n");
  expect(lines[0]).toBe(
    "Unread window: 2 returned, seq 6-8, oldest to newest, starting after your read position (seq 3).",
  );
  expect(lines[2]).toBe("3 messages you were already shown (seq 4-7) are not repeated.");
  expect(lines.findIndex((line) => line.startsWith("[1/2"))).toBeGreaterThan(2);
});

test("the fold line is singular for one message and names a single seq", () => {
  const output = formatReadWindow(
    "#general",
    {
      messages: [message(8)],
      unreadCursorBefore: 3,
      readPositionAfter: 8,
      foldedMessageCount: 1,
      foldedFromSequence: 5,
      foldedThroughSequence: 5,
    },
    unread,
  );
  expect(output).toContain("1 message you were already shown (seq 5) is not repeated.");
});

test("an unread page that is all folded says there is nothing new and still ends with the footer", () => {
  const output = formatReadWindow(
    "#general",
    {
      messages: [],
      unreadCursorBefore: 3,
      readPositionAfter: 5,
      moreUnread: true,
      foldedMessageCount: 2,
      foldedFromSequence: 4,
      foldedThroughSequence: 5,
    },
    unread,
  );
  expect(output.split("\n")).toEqual([
    "No new unread messages in #general. 2 messages you were already shown (seq 4-5) are not repeated.",
    'More unread remain. Next: coforge message read --target "#general" --unread',
  ]);
});

test("a fold with an unmoved read position says how to see the messages again", () => {
  const output = formatReadWindow(
    "#general",
    {
      messages: [],
      unreadCursorBefore: 5,
      readPositionAfter: 5,
      foldedMessageCount: 1,
      foldedFromSequence: 5,
      foldedThroughSequence: 5,
    },
    unread,
  );
  expect(output).toContain(
    '1 message you were already shown (seq 5) is not repeated. To see it again: coforge message read --target "#general" --after 5',
  );
});

test("an unread read that shows messages without moving the position omits the position line", () => {
  const output = formatReadWindow(
    "#general",
    { messages: [message(4)], unreadCursorBefore: 4, readPositionAfter: 4, moreUnread: true },
    unread,
  );
  expect(output).not.toContain("Read position");
  expect(output).toContain("More unread remain.");
  expect(output).not.toContain("No more unread");
});

test("an unread read with nothing at all starts with the coverage, a blank line, and where the Agent stands", () => {
  const lines = formatReadWindow(
    "#general",
    { messages: [], unreadCursorBefore: 9, readPositionAfter: 9 },
    unread,
  ).split("\n");
  expect(lines[0]).toStartWith("Coverage:");
  expect(lines.slice(1)).toEqual([
    "",
    "No unread messages in #general. You have read through seq 9.",
  ]);
});

test("an unread page with nothing from others but more beyond it says to keep reading", () => {
  const lines = formatReadWindow(
    "#general",
    { messages: [], unreadCursorBefore: 10, readPositionAfter: 60, moreUnread: true },
    unread,
  ).split("\n");
  expect(lines.slice(1)).toEqual([
    "",
    "No unread messages from others in #general up to seq 60.",
    'More unread remain. Next: coforge message read --target "#general" --unread',
  ]);
});

test("a plain read names the server unread cursor even when it is 0", () => {
  const output = formatReadWindow(
    "#general",
    { messages: [message(1)], unreadCursorBefore: 0 },
    {},
  );
  expect(output).toContain(
    'Server unread cursor before this read: seq 0. Use coforge message read --target "#general" --after 0 to browse newer messages.',
  );
});
