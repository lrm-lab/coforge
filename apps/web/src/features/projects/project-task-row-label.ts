import type { TaskLink, TaskName } from "@lrm/coforge-sdk/internal";

import { taskMetaLabel } from "#src/features/tasks/task-meta-label";
import { openBlockers } from "#src/features/tasks/task-relation-edits";
import { statusLabel } from "#src/features/tasks/task-status-icon";
import { m } from "#src/paraglide/messages";
import type { ProjectTask } from "./project-tasks";

/** A Task it waits on, as the reader may name it. */
function blockerName(task: TaskName | TaskLink) {
  if (task.hidden) return m.tasks_ref_hidden();
  return "title" in task ? `${task.title} ${taskMetaLabel(task)}` : taskMetaLabel(task);
}

/** How many blockers a row's label names; the press-opened list has them all. */
const NAMED_BLOCKERS = 3;

/**
 * What a screen reader says for a row: its name, its status, the first Tasks it waits on by name
 * (then how many more), how far its sub-tasks are, and whether the filter passes it. Its level comes from the tree itself
 * (`aria-level`). The names are in the label, not a description: React Aria's `TreeItem` takes no
 * `aria-describedby`.
 */
export function rowLabel(
  task: Pick<ProjectTask, "number" | "title" | "status" | "blockedBy" | "subtasks">,
  matched: boolean,
) {
  const open = openBlockers(task.blockedBy);
  return [
    `#${task.number} ${task.title}`,
    statusLabel(task.status),
    open.length > 0 &&
      `${m.tasks_blocked_by()} ${[
        ...open.slice(0, NAMED_BLOCKERS).map(blockerName),
        open.length > NAMED_BLOCKERS &&
          m.project_task_tree_more_blockers({ count: open.length - NAMED_BLOCKERS }),
      ]
        .filter(Boolean)
        .join(", ")}`,
    task.subtasks && m.tasks_subtasks_finished(task.subtasks),
    !matched && m.project_task_tree_outside(),
  ]
    .filter(Boolean)
    .join(", ");
}
