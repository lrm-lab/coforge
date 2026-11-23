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
import { TaskDueMenu } from "./task-due-menu";
import { TaskLabelsField } from "./task-labels";
import { TaskProjectMenu } from "./task-project-menu";
import { TaskPriorityMenu } from "./task-priority-menu";
import { BARE_CHIP, TaskProperty } from "./task-property";
import { StatusPicker } from "./task-status-menu";

export type CreateTaskDraftPatch = {
  assignee?: string;
  labels?: string[];
  priority?: TaskPriorityLevel;
  dueAt?: string;
  dueHasTime?: boolean;
  project?: TaskProjectRef | null;
};

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
  lastUsed?: TaskProjectRef | null;
  draft: {
    labels: string[];
    priority: TaskPriorityLevel | undefined;
    dueAt: string | undefined;
    dueHasTime?: boolean;
  };
  saving: boolean;
  onChange: (patch: CreateTaskDraftPatch) => void;
}) {
  return (
    <div
      data-layout="create"
      className="flex shrink-0 flex-wrap gap-2 px-4 pt-1 pb-5 max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:overscroll-x-contain max-sm:border-t max-sm:border-secondary max-sm:py-2 max-sm:pe-6 max-sm:scroll-px-5 max-sm:scroll-fade-x max-sm:[scrollbar-width:none] sm:px-6"
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
      <TaskProperty label={m.tasks_due()}>
        <TaskDueMenu
          dueAt={draft.dueAt}
          dueHasTime={draft.dueHasTime}
          disabled={saving}
          onSelect={(dueAt, dueHasTime) =>
            onChange({
              dueAt: dueAt ?? undefined,
              dueHasTime: dueAt ? dueHasTime : undefined,
            })
          }
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
