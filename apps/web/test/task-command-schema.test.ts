import { expect, test } from "bun:test";

import { taskCommand } from "#src/features/tasks/task-command-schema";

const amend = {
  operation: "amend",
  idempotencyKey: "0b8a3c1e-5d2f-4a6b-9c7d-1e2f3a4b5c6d",
  conversationId: "1c9b4d2f-6e3a-4b7c-8d9e-2f3a4b5c6d7e",
  number: 7,
} as const;

test("a person's amend may file the Task under a Project by slug, or clear it with null", () => {
  expect(taskCommand.parse({ ...amend, project: "launch" }).project).toBe("launch");
  expect(taskCommand.parse({ ...amend, project: null }).project).toBeNull();
  expect(taskCommand.parse(amend).project).toBeUndefined();
  // A slug typed with stray spaces still names the Project, as `--project` does in the CLI.
  expect(taskCommand.parse({ ...amend, project: " launch " }).project).toBe("launch");
  expect(() => taskCommand.parse({ ...amend, project: "  " })).toThrow();
});

test("a Project slug must be a non-empty string no longer than a Project slug may be", () => {
  expect(taskCommand.parse({ ...amend, project: "x".repeat(100) }).project).toHaveLength(100);
  expect(() => taskCommand.parse({ ...amend, project: "" })).toThrow();
  expect(() => taskCommand.parse({ ...amend, project: "x".repeat(101) })).toThrow();
});

test("a person's page may restore a Task it just deleted (task #507)", () => {
  expect(taskCommand.parse({ ...amend, operation: "restore" }).operation).toBe("restore");
});
