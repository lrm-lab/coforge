import { expect, test } from "bun:test";
import { taskRequestSchema } from "#src/routes/api/agent/v1/tasks";

test("the Agent HTTP task schema accepts Backlog filters and refuses Backlog writes", () => {
  const command = { operation: "list", idempotencyKey: "read", target: "#work", status: "backlog" };
  expect(() => taskRequestSchema.parse(command)).not.toThrow();
  expect(() =>
    taskRequestSchema.parse({ ...command, status: undefined, statuses: ["backlog"] }),
  ).not.toThrow();
  for (const operation of ["create", "update"]) {
    expect(() =>
      taskRequestSchema.parse({ ...command, operation, number: 1, title: "Park" }),
    ).toThrow();
  }
});
