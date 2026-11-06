import { expect, test } from "bun:test";

import { taskCommand } from "#src/features/tasks/task-command-schema";
import { validateTaskCommand } from "#src/server/tasks/task-command-validation.server";

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

test("a new Task may be filed under no Project, and only a create or an amend names one", () => {
  const create = {
    operation: "create",
    title: "Book the room",
    idempotencyKey: "01a1b018-491b-7400-b5dc-abda25729401",
    conversationId: "01a17cde-2786-7298-b3fe-ca229afcbf3d",
  } as const;
  expect(() => validateTaskCommand({ ...create, project: null } as never)).not.toThrow();
  expect(() => validateTaskCommand({ ...create, project: "launch" } as never)).not.toThrow();
  expect(() => validateTaskCommand({ ...create, project: "  " } as never)).toThrow();
  expect(() =>
    validateTaskCommand({ ...create, operation: "claim", project: null } as never),
  ).toThrow();
});
