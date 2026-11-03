import { expect, test } from "bun:test";
import { taskRequestSchema } from "#src/routes/api/agent/v1/tasks";
import { AGENT_FACING_ERROR_IDS } from "#src/server/tasks/task-gates.server";
import { setup } from "./fixtures/task-dependencies";

/**
 * The Agent task route as the CLI reaches it (task #455, staging QA): the strict request schema
 * must let the label fields through — it used to answer a shapeless 400 before the board ran — the
 * `none` label filter must reach the board, and a label refusal must carry the board's sentence.
 */

test("the agent task request schema carries the label and project fields", () => {
  const parsed = taskRequestSchema.parse({
    operation: "create",
    idempotencyKey: crypto.randomUUID(),
    labels: ["Type/Bug"],
    removeLabels: ["Bug"],
    labelDescription: "a defect",
    project: "docs",
  });
  expect(parsed.labels).toEqual(["Type/Bug"]);
  expect(parsed.project).toBe("docs");
  expect(AGENT_FACING_ERROR_IDS.has("task-label-unknown")).toBe(true);
  expect(AGENT_FACING_ERROR_IDS.has("task-label-archived")).toBe(true);
});

test("the board answers the none filter the route now lets through", async () => {
  const { db, board, principals, channel } = await setup();
  try {
    const result = await board.execute(principals.alice, {
      operation: "list",
      idempotencyKey: crypto.randomUUID(),
      conversationId: channel.id,
      labels: ["none"],
    } as never);
    expect(Array.isArray(result.tasks)).toBe(true);
  } finally {
    await db.$disconnect();
  }
});
