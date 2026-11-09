import { expect, test } from "bun:test";

import {
  messageWindowTasks,
  taskNumberReads,
} from "#src/features/tasks/conversation-tasks-collection";

/** The conversation the message windows below belong to. */
const HERE = "66666666-6666-4666-8666-666666666666";

test("a message window asks for the Tasks from its first message on, and the Tasks its bodies name", () => {
  const messages = [
    { sequence: 41, body: "see <@task:3> and <@task:12>" },
    { sequence: 43, body: "plain" },
    { sequence: 47, body: "<@task:3> again, and <@task:1>" },
  ];
  // At the live end the window has no upper bound: a message that arrives later is inside it.
  expect(messageWindowTasks(messages, false, HERE)).toEqual({
    sequenceFrom: 41,
    numbers: [1, 3, 12],
  });
  // A window pinned in history ends at its last message.
  expect(messageWindowTasks(messages, true, HERE)).toEqual({
    sequenceFrom: 41,
    sequenceTo: 47,
    numbers: [1, 3, 12],
  });
  expect(messageWindowTasks([], false, HERE)).toBeUndefined();
});

test("another conversation's task tokens ask this conversation for no Task; its own name does", () => {
  const other = "550e8400-e29b-41d4-a716-446655440000";
  const messages = [
    {
      sequence: 41,
      body: `<@task:c:${other}:design:7>, <@task:d:${other}:ada:9>, <@task:c:${HERE}:here:5> and <@task:2>`,
    },
  ];
  expect(messageWindowTasks(messages, false, HERE)).toEqual({ sequenceFrom: 41, numbers: [2, 5] });
});

test("the same messages ask for the same subset, so a realtime message with no reference reads nothing", () => {
  const first = [{ sequence: 41, body: "see <@task:3>" }];
  const later = [...first, { sequence: 42, body: "hello" }];
  expect(messageWindowTasks(later, false, HERE)).toEqual(messageWindowTasks(first, false, HERE));
});

test("a window naming more Tasks than one read takes asks for them all, a read per block of numbers", () => {
  // A busy channel's history: #1 to #250, then #682, #701 and #709 (task #coforge-ui:#26, where
  // only the first 200 were read and the newest references showed as bare numbers).
  const named = [...Array.from({ length: 250 }, (_, index) => index + 1), 682, 701, 709];
  const messages = named.map((number, index) => ({
    sequence: index + 1,
    body: `<@task:${number}>`,
  }));
  const window = messageWindowTasks(messages, false, HERE)!;
  expect(window.numbers).toEqual(named);
  const reads = taskNumberReads(window.numbers);
  expect(reads.map((read) => read.numbers.length)).toEqual([200, 50, 3]);
  expect(reads.flatMap((read) => read.numbers)).toEqual(named);
  for (const read of reads) expect(read.numbers.length).toBeLessThanOrEqual(200);
  // A block's read stays the same when another block gains a number.
  const more = taskNumberReads([...window.numbers, 300]);
  expect(more.find((read) => read.block === 0)).toEqual(reads.find((read) => read.block === 0));
});
