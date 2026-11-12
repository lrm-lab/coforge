import { expect, test } from "bun:test";

import { messageWindowTasks } from "#src/features/tasks/conversation-tasks-collection";

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
    reads: [{ key: "2.0", numbers: [1, 3, 12] }],
  });
  // A window pinned in history ends at its last message.
  expect(messageWindowTasks(messages, true, HERE)).toEqual({
    sequenceFrom: 41,
    sequenceTo: 47,
    reads: [{ key: "2.0", numbers: [1, 3, 12] }],
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
  expect(messageWindowTasks(messages, false, HERE)).toEqual({
    sequenceFrom: 41,
    reads: [{ key: "2.0", numbers: [2, 5] }],
  });
});

test("the same messages ask for the same subset, so a realtime message with no reference reads nothing", () => {
  const first = [{ sequence: 41, body: "see <@task:3>" }];
  const later = [...first, { sequence: 42, body: "hello" }];
  expect(messageWindowTasks(later, false, HERE)).toEqual(messageWindowTasks(first, false, HERE));
});

test("a window's named Tasks are read a stretch of messages at a time, however high the numbers", () => {
  // A busy channel's history: #1 to #250, then #682, #701 and #709 (task #coforge-ui:#26, where
  // only the first 200 were read and the newest references showed as bare numbers), and numbers
  // scattered over 10,000 Tasks.
  const named = [
    ...Array.from({ length: 250 }, (_, index) => index + 1),
    682,
    701,
    709,
    4005,
    9800,
  ];
  const messages = named.map((number, index) => ({
    sequence: index + 1,
    body: `<@task:${number}>`,
  }));
  const window = messageWindowTasks(messages, false, HERE)!;
  // 255 messages make 13 stretches of 20 by sequence; scattered numbers add none.
  expect(window.reads).toHaveLength(13);
  expect(window.reads.flatMap((read) => read.numbers).sort((a, b) => a - b)).toEqual(named);
  // One message naming more than a read takes is split.
  const crowded = messageWindowTasks(
    [{ sequence: 1, body: named.map((number) => `<@task:${number}>`).join(" ") }],
    false,
    HERE,
  )!;
  expect(crowded.reads.map((read) => read.numbers.length)).toEqual([200, 55]);
  // A page of older messages and a new message add their own reads and leave the others as they were.
  const paged = messageWindowTasks(
    [{ sequence: 300, body: "<@task:9900>" }, ...messages.slice(100)],
    false,
    HERE,
  )!;
  const before = messageWindowTasks(messages.slice(100), false, HERE)!;
  for (const read of before.reads) expect(paged.reads).toContainEqual(read);
  expect(paged.reads).toHaveLength(before.reads.length + 1);
});

test("a written `#name:#N` under this channel's own name asks for its Task; another channel's does not", () => {
  // An Agent's reply keeps `#artifacts:#20` as typed and the message draws it as this channel's
  // Task, so the window reads it too (task #coforge-designer-team:#97, where it stayed a bare "#20").
  const messages = [
    { sequence: 41, body: "It's filed as #artifacts:#20, see also #Artifacts:#4 and #design:#7" },
    { sequence: 42, body: "#artifacts:#20x and #artifacts:#3:#9 are not references" },
  ];
  expect(messageWindowTasks(messages, false, HERE, "artifacts")).toEqual({
    sequenceFrom: 41,
    reads: [{ key: "2.0", numbers: [4, 20] }],
  });
  // A direct message has no channel name: nothing written names it.
  expect(messageWindowTasks(messages, false, HERE)).toEqual({ sequenceFrom: 41, reads: [] });
});
