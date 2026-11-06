import { expect, test } from "bun:test";

import {
  otherTaskParam,
  otherTaskParamSchema,
  parseOtherTask,
  type OtherTask,
} from "#src/features/tasks/other-task-search";

const conversationId = "01a1afdf-2158-7210-8c17-7af3639438a6";

test("a Task's param reads back as the same Task, for a channel and a direct message", () => {
  const tasks: OtherTask[] = [
    { kind: "channel", conversationId, number: 7 },
    { kind: "dm", conversationId, number: 120 },
  ];
  for (const task of tasks) expect(parseOtherTask(otherTaskParam(task))).toEqual(task);
});

test("a malformed param is no popup, and no error for the page", () => {
  for (const param of [
    "7",
    `${conversationId}:7`,
    `thread:${conversationId}:7`,
    `channel:${conversationId}:0`,
    `channel:${conversationId}:7:8`,
    "channel:not-a-uuid:7",
  ]) {
    expect(parseOtherTask(param)).toBeUndefined();
    expect(otherTaskParamSchema.parse(param)).toBeUndefined();
  }
  expect(parseOtherTask(undefined)).toBeUndefined();
});
