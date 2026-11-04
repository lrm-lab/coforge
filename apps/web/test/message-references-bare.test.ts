import { expect, test } from "bun:test";
import { channelReferenceToken, taskReferenceToken } from "@lrm/coforge-sdk/internal";
import { readMessageReferences, type MessageReferenceLookup } from "#src/lib/message-references";

const messageReferenceCandidates = (body: string) => readMessageReferences(body).candidates;
const resolveMessageReferences = (body: string, lookup: MessageReferenceLookup) =>
  readMessageReferences(body).resolve(lookup).body;

const DIGITS = { id: "55555555-5555-4555-8555-555555555555", name: "132" };
const channel = (name: string) => (name === DIGITS.name ? DIGITS : undefined);
const task132 = (number: number) => (number === 132 ? "task-132" : undefined);

test("a bare #N naming a task of the conversation becomes a task token; any other #N stays text", () => {
  expect(resolveMessageReferences("就是 #132）。先看 #734", { task: task132, channel })).toBe(
    `就是 ${taskReferenceToken(132)}）。先看 #734`,
  );
});

test("a bare #N is a task before it is a channel of the same name", () => {
  // Channel `132` exists; task 132 does too, so the reference is the task.
  expect(resolveMessageReferences("#132", { task: task132, channel })).toBe(
    taskReferenceToken(132),
  );
  // With no task 132 it falls through to the channel called `132`, and with neither it is text.
  expect(resolveMessageReferences("#132", { task: () => undefined, channel })).toBe(
    channelReferenceToken(DIGITS.id, "132"),
  );
  expect(resolveMessageReferences("#132", { task: () => undefined })).toBe("#132");
});

test("a bare #N lists the number as a task candidate and as a channel name", () => {
  expect(messageReferenceCandidates("#68 on its own")).toEqual({
    handles: [],
    taskNumbers: [68],
    channelNames: ["68"],
    threads: [],
    channelTasks: [],
    dmTasks: [],
  });
});

test("a bare #N needs a boundary before it, no leading zero, and no word character after it", () => {
  for (const body of ["issues/#132", "word#132", "#1320", "#132a", "#0132", "#132_x"])
    expect(resolveMessageReferences(body, { task: task132 })).toBe(body);
  // Punctuation or another script right after the number ends it.
  expect(resolveMessageReferences("(#132), #132。#132的问题", { task: task132 })).toBe(
    `(${taskReferenceToken(132)}), ${taskReferenceToken(132)}。${taskReferenceToken(132)}的问题`,
  );
  // Emphasis before the `#` is markup, not a word character.
  expect(resolveMessageReferences("**see**#132", { task: task132 })).toBe(
    `**see**${taskReferenceToken(132)}`,
  );
});

test("a channel named by the whole #name run wins over a task that is only its number", () => {
  const plan = { id: "66666666-6666-4666-8666-666666666666", name: "132-plan" };
  const withPlan = (name: string) => (name === plan.name ? plan : channel(name));
  expect(resolveMessageReferences("#132-plan", { task: task132, channel: withPlan })).toBe(
    channelReferenceToken(plan.id, "132-plan"),
  );
  // No such channel: the number is still the task, and the rest of the run stays as written.
  expect(resolveMessageReferences("#132-Plan", { task: task132, channel })).toBe(
    `${taskReferenceToken(132)}-Plan`,
  );
  expect(messageReferenceCandidates("#132-Plan")).toEqual({
    handles: [],
    taskNumbers: [132],
    channelNames: ["132-plan"],
    threads: [],
    channelTasks: [],
    dmTasks: [],
  });
});

test("an escape later in a bare #N's run keeps the task; only the channel reading needs the whole run", () => {
  const underscored = { id: "77777777-7777-4777-8777-777777777777", name: "132-_b_" };
  const withUnderscored = (name: string) =>
    name === underscored.name ? underscored : channel(name);
  // The number is written exactly, so it is still the task; the escaped rest stays as written, and
  // the channel the unescaped run would name is not read.
  expect(
    resolveMessageReferences("see #132-\\_b\\_ now", { task: task132, channel: withUnderscored }),
  ).toBe(`see ${taskReferenceToken(132)}-\\_b\\_ now`);
  expect(messageReferenceCandidates("#132-\\_b\\_")).toEqual({
    handles: [],
    taskNumbers: [132],
    channelNames: [],
    threads: [],
    channelTasks: [],
    dmTasks: [],
  });
  // With no such task the run stays byte-for-byte.
  expect(
    resolveMessageReferences("#132-\\_b\\_", { task: () => undefined, channel: withUnderscored }),
  ).toBe("#132-\\_b\\_");
});

test("a bare #N in code, a link, a URL, an escape or a thread reference is never a reference", () => {
  for (const body of [
    "`#132`",
    "```\n#132\n```",
    "[see #132](https://example.com)",
    "https://github.com/org/repo/pull/7#132",
    "<https://example.com/#132>",
    "\\#132",
    "#132:deadbeef",
  ])
    expect(resolveMessageReferences(body, { task: task132, channel })).toBe(body);
});

test("`task #N` keeps the whole phrase; a bare #N after it is read on its own", () => {
  expect(
    resolveMessageReferences("task #132 and #132", { task: task132, channel: () => undefined }),
  ).toBe(`${taskReferenceToken(132)} and ${taskReferenceToken(132)}`);
});
