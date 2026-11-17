import { expect, test } from "bun:test";
import type { TaskLink, TaskStatus } from "@lrm/coforge-sdk/internal";

import { rowLabel } from "#src/features/projects/project-task-row-label";
import { m } from "#src/paraglide/messages";

/**
 * What a screen reader says for a row of a Project's task tree (task #462): the first three
 * blockers by name, a blocker the reader cannot read only as such, how many more, the sub-task
 * progress, and "not in the filter" for an ancestor kept by it. Compared through the messages, so
 * the test holds in every locale.
 */
const blocker = (number: number, status: TaskStatus = "todo"): TaskLink => ({
  hidden: false,
  number,
  channel: null,
  title: `Blocker ${number}`,
  status,
});
type Row = Parameters<typeof rowLabel>[0];
const row = (extra: Partial<Row>): Row => ({
  number: 9,
  title: "Buy the domain",
  status: "todo",
  blockedBy: [],
  subtasks: null,
  ...extra,
});

test("a row names the first three blockers, then how many more; an unreadable one is not named", () => {
  const label = rowLabel(
    row({
      blockedBy: [blocker(1), blocker(2), blocker(3), { hidden: true, status: "todo" }],
    }),
    true,
  );
  expect(label).toContain("#9 Buy the domain");
  expect(label).toContain("Blocker 1 #1");
  expect(label).toContain("Blocker 3 #3");
  // The hidden one sorts last, so it is the one counted rather than named.
  expect(label).not.toContain(m.tasks_ref_hidden());
  expect(label).toContain(m.project_task_tree_more_blockers({ count: 1 }));
});

test("an unreadable blocker among the first three reads as such, never by title", () => {
  const label = rowLabel(row({ blockedBy: [{ hidden: true, status: "todo" }, blocker(1)] }), true);
  expect(label).toContain(m.tasks_ref_hidden());
  expect(label).not.toContain(m.project_task_tree_more_blockers({ count: 0 }));
});

test("a finished blocker is not waited on, and nothing is said without blockers", () => {
  const label = rowLabel(row({ blockedBy: [blocker(1, "done")] }), true);
  expect(label).not.toContain(m.tasks_blocked_by());
  expect(label).not.toContain("Blocker 1");
});

test("sub-task progress is read out, and a row the filter does not pass says so", () => {
  const subtasks = { finished: 1, total: 3 };
  expect(rowLabel(row({ subtasks }), true)).toContain(m.tasks_subtasks_finished(subtasks));
  expect(rowLabel(row({ subtasks }), true)).not.toContain(m.project_task_tree_outside());
  expect(rowLabel(row({}), false)).toContain(m.project_task_tree_outside());
});
