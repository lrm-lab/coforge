import { expect, test } from "bun:test";
import { taskRequestSchema } from "#src/routes/api/agent/v1/tasks";

test("the Agent HTTP task schema accepts Backlog reads, creates, and updates with optional reason", () => {
  const base = { idempotencyKey: "req-1", target: "#work" };
  expect(() =>
    taskRequestSchema.parse({ ...base, operation: "list", status: "backlog" }),
  ).not.toThrow();
  expect(() =>
    taskRequestSchema.parse({ ...base, operation: "list", statuses: ["backlog"] }),
  ).not.toThrow();
  expect(() =>
    taskRequestSchema.parse({
      ...base,
      operation: "create",
      title: "Park",
      status: "backlog",
      messageId: "m1",
    }),
  ).not.toThrow();
  expect(() =>
    taskRequestSchema.parse({
      ...base,
      operation: "create",
      title: "Invalid",
      status: "done",
      messageId: "m1",
    }),
  ).toThrow();
  expect(() =>
    taskRequestSchema.parse({
      ...base,
      operation: "update",
      number: 1,
      status: "backlog",
      reason: "waiting on API",
    }),
  ).not.toThrow();
  expect(() =>
    taskRequestSchema.parse({
      ...base,
      operation: "update",
      number: 1,
      status: "in_review",
    }),
  ).not.toThrow();
});
