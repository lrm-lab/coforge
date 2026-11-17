import { expect, test } from "bun:test";
import { taskRequestSchema } from "#src/routes/api/agent/v1/tasks";
import type { z } from "zod";

type MustBeNever<Value extends never> = Value;
export type AgentWriteRejectsBacklog = MustBeNever<
  Extract<
    {
      operation: "update";
      status: "backlog";
      number: number;
      idempotencyKey: string;
      target: string;
    },
    z.input<typeof taskRequestSchema>
  >
>;

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
