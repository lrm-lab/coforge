import type {
  TaskPriorityLevel,
  TaskProjectRef,
  TaskWriteStatus,
  TaskView,
} from "@lrm/coforge-sdk/internal";

import type { Mentionable } from "#src/features/conversations/mention-text";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AssigneeMenu } from "./task-assignee-menu";
import { TaskLabelsField } from "./task-labels";
import { TaskProjectMenu } from "./task-project-menu";
import { TaskPriorityMenu } from "./task-priority-menu";
import { BARE_CHIP, TaskProperty } from "./task-property";
import { StatusPicker } from "./task-status-menu";

/** What a new Task's chips row can change in its draft. */
export type CreateTaskDraftPatch = {
  assignee?: string;
  labels?: string[];
  priority?: TaskPriorityLevel;
  project?: TaskProjectRef | null;
};

/**
 * What else a new Task starts with, as the chips under its description: its status on a board,
 * owner, priority, Project and labels — the properties the Task popup edits, in a form.
 */
export function CreateTaskProperties({
  board,
  assignable,
  task,
  offersProject,
  lastUsed,
  draft,
  saving,
  onChange,
}: {
  board?: {
    status: TaskWriteStatus;
    statuses: readonly TaskWriteStatus[];
    onStatusChange: (status: TaskWriteStatus) => void;
  };
  assignable?: readonly Mentionable[];
  task: Pick<TaskView, "owner" | "labels" | "project">;
  offersProject: boolean;
  /** In a conversation's form: the Project the viewer last filed a Task under, offered first. */
  lastUsed?: TaskProjectRef | null;
  draft: {
    labels: string[];
    priority: TaskPriorityLevel | undefined;
  };
  saving: boolean;
  onChange: (patch: CreateTaskDraftPatch) => void;
}) {
  return (
    <div
      data-layout="create"
      className="flex shrink-0 flex-wrap gap-2 px-4 pt-1 pb-5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:border-t max-sm:border-secondary max-sm:py-2 max-sm:[scrollbar-width:none] sm:px-6"
    >
      {board && (
        <TaskProperty label={m.tasks_overview_status()}>
          <StatusPicker
            status={board.status}
            options={board.statuses}
            disabled={saving}
            onSelect={board.onStatusChange}
          />
        </TaskProperty>
      )}
      {assignable && (
        <TaskProperty label={m.tasks_overview_owner()}>
          <AssigneeMenu
            task={task}
            members={assignable}
            disabled={saving}
            onSelect={(assignee) => onChange({ assignee: assignee ?? undefined })}
          />
        </TaskProperty>
      )}
      <TaskProperty label={m.tasks_priority()}>
        <TaskPriorityMenu
          priority={draft.priority}
          disabled={saving}
          onSelect={(priority) => onChange({ priority })}
        />
      </TaskProperty>
      {offersProject && (
        <TaskProperty label={m.tasks_project()}>
          <TaskProjectMenu
            task={task}
            disabled={saving}
            lastUsed={lastUsed}
            onSelect={(project) => onChange({ project })}
          />
        </TaskProperty>
      )}
      <TaskProperty
        label={m.tasks_labels()}
        // As in the popup: labels are chips of their own, not a name to truncate.
        className={cn("[[data-layout=create]_&]:max-w-none", draft.labels.length > 0 && BARE_CHIP)}
      >
        <TaskLabelsField
          task={task}
          disabled={saving}
          onChange={({ add = [], remove = [] }) =>
            onChange({
              labels: [
                ...draft.labels.filter((name) => !remove.includes(name)),
                ...add.filter((name) => !draft.labels.includes(name)),
              ],
            })
          }
        />
      </TaskProperty>
    </div>
  );
}
