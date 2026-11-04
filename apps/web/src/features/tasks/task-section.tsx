import { MAX_TASK_BLOCKERS, MAX_TASK_TREE_DEPTH, type TaskView } from "@lrm/coforge-sdk/internal";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import type { Mentionable } from "#src/features/conversations/mention-text";
import { isAppError } from "#src/lib/app-error";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { CreateTaskDialog } from "./create-task-dialog";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "./task-assignment";
import { AssigneeMenu } from "./task-assignee-menu";
import { getTaskMoveCommand } from "./task-move";
import { TaskPickerDialog } from "./task-picker";
import { SubtaskPickerDialog } from "./task-subtask-picker";
import { TaskProperty } from "./task-property";
import { openBlockers, relationRefusal, type VisibleTaskName } from "./task-relation-edits";
import { TaskBlockedByValue, TaskBlockingValue, TaskParentValue } from "./task-relation-lines";
import { TaskProjectMenu } from "./task-project-menu";
import { TaskLabelsField } from "./task-labels";
import { StatusMenu } from "./task-status-menu";
import { executeTask } from "./tasks.functions";
import { useTaskAssignmentAccess } from "./use-task-assignment-access";
import { useConversationTaskWrites } from "./use-conversation-tasks";
import { useTaskRelations, type DetailCommand } from "./use-task-relations";

/** What the header menu asked to add, each in a dialog: a parent, a blocker, a new sub-task, or an
 * existing Task as a sub-task (task #505). */
export type RelationPicker = "parent" | "blocker" | "subtask" | "existing-subtask";

type SectionError = "permission" | "denied" | "invalid" | "other";

function errorText(error: SectionError) {
  switch (error) {
    case "permission":
      return m.tasks_assignment_requires_workspace_manager();
    case "denied":
      return m.tasks_relation_denied();
    case "invalid":
      return m.tasks_relation_invalid({ depth: MAX_TASK_TREE_DEPTH, blockers: MAX_TASK_BLOCKERS });
    case "other":
      return m.tasks_update_failed();
  }
}

/**
 * The popup's block above its tabs: the Task's title and a compact grid of its properties, with
 * its parent, what it waits on and what waits on it among them. Relations show only where the
 * Workspace has Tasks v2 on.
 */
export function TaskSection({
  layout = "column",
  task,
  onCommand,
  members,
  currentMemberId,
  picker,
  onPickerChange,
  onOpenRelated,
  projectField = true,
}: {
  /** Whether the Task can be filed under a Project: not one in a direct conversation. */
  projectField?: boolean;
  /** One column under the title, a column beside the pages, or one row of chips (a phone). */
  layout?: "column" | "sidebar" | "chips";
  task: TaskView;
  onCommand?: (command: DetailCommand) => Promise<void>;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  /** The picker the header menu (or the sub-tasks' "+") opened, if any. The popup owns it, since
   * its header menu opens one too. */
  picker: RelationPicker | null;
  onPickerChange: (picker: RelationPicker | null) => void;
  /** Opens a related Task (another popup, in its own channel if that is where it lives). */
  onOpenRelated?: (task: VisibleTaskName) => void;
}) {
  const execute = useServerFn(executeTask);
  const writeTasks = useConversationTaskWrites();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SectionError | null>(null);
  const access = useTaskAssignmentAccess();
  const canEditAssignment =
    access.canAssignOthers || !task.owner || task.owner.memberId === currentMemberId;
  const assignableMembers = access.canAssignOthers
    ? members
    : members?.filter((member) => member.kind === "user" && member.id === access.userId);
  async function run(command: DetailCommand) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      if (onCommand) {
        await onCommand(command);
      } else {
        // No external owner: run it here, then write the server's copies into the conversation's
        // Tasks, so the chip, the popup and the Tasks tab show the change without reading again.
        const result = await execute({
          data: {
            ...command,
            idempotencyKey: crypto.randomUUID(),
            conversationId: task.conversationId,
          },
        });
        writeTasks(task.conversationId, [{ tasks: result.tasks, deleted: [] }]);
      }
    } catch (failure) {
      const permission =
        isAppError(failure) && failure.errorId === TASK_ASSIGNMENT_MANAGER_REQUIRED;
      setError(permission ? "permission" : (relationRefusal(failure) ?? "other"));
      if (permission) void access.refetch();
    } finally {
      setPending(false);
    }
  }
  const relations = useTaskRelations({ task, currentMemberId, run });
  const closePicker = (open: boolean) => !open && onPickerChange(null);

  return (
    // The discussion is what this popup is for, so the Task sits above it as its title and a
    // compact grid: a short label and a one-line value per property, two to a row, with nothing
    // shown for a relation it does not have. A value with more behind it opens it in a popover.
    // The creator is History's first entry; History and the sub-tasks are tabs under the grid.
    <section
      className={cn(
        "flex flex-col gap-2",
        layout === "column" && "px-4 sm:px-6",
        layout === "chips" && "min-w-0",
      )}
    >
      <dl
        data-layout={layout}
        className={cn(
          "flex",
          layout === "sidebar" && "flex-col gap-3",
          layout === "column" && "flex-col",
          // One row that scrolls sideways when it does not fit; the page's edge stays its margin.
          layout === "chips" &&
            "gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        )}
      >
        {/* As chips (a phone), what blocks the Task comes right after its status, where the row
            is seen without scrolling; the rest follow (`order-2`). */}
        <TaskProperty label={m.tasks_overview_status()}>
          <StatusMenu
            task={task}
            currentMemberId={currentMemberId}
            disabled={pending}
            onSelect={(status) => {
              const command = getTaskMoveCommand(task, currentMemberId, status);
              if (command) void run(command);
            }}
          />
        </TaskProperty>
        <TaskProperty label={m.tasks_overview_owner()} className="[[data-layout=chips]_&]:order-2">
          <AssigneeMenu
            task={task}
            members={assignableMembers}
            disabled={pending || !currentMemberId || !canEditAssignment}
            onSelect={(assignee) =>
              void run(
                assignee
                  ? { operation: "assign", number: task.number, assignee }
                  : { operation: "unassign", number: task.number },
              )
            }
          />
        </TaskProperty>
        {projectField && (
          <TaskProperty label={m.tasks_project()} className="[[data-layout=chips]_&]:order-2">
            <TaskProjectMenu
              task={task}
              disabled={pending}
              onSelect={(project) => void run({ operation: "amend", number: task.number, project })}
            />
          </TaskProperty>
        )}
        <TaskProperty label={m.tasks_labels()} className="[[data-layout=chips]_&]:order-2">
          <TaskLabelsField
            task={task}
            disabled={pending}
            onChange={({ add, remove }) =>
              void run({
                operation: "amend",
                number: task.number,
                ...(add && { labels: add }),
                ...(remove && { removeLabels: remove }),
              })
            }
          />
        </TaskProperty>
        {relations.on && task.parent && (
          <TaskProperty
            label={m.tasks_parent()}
            labelInChip
            className="[[data-layout=chips]_&]:order-2"
          >
            <TaskParentValue
              parent={task.parent}
              disabled={pending}
              onOpen={onOpenRelated}
              onClear={relations.canEdit ? () => void relations.clearParent() : undefined}
            />
          </TaskProperty>
        )}
        {relations.on && openBlockers(task.blockedBy).length > 0 && (
          <TaskProperty label={m.tasks_blocked_by()} labelInChip>
            <TaskBlockedByValue
              task={task}
              blockedBy={task.blockedBy}
              rules={relations.blockerRules}
              disabled={pending || !relations.canEdit}
              onOpen={onOpenRelated}
              onAdd={(blocker) => void relations.addBlocker(blocker)}
              onRemove={(blocker) => void relations.removeBlocker(blocker)}
            />
          </TaskProperty>
        )}
        {relations.on && relations.detail.blocking.length > 0 && (
          <TaskProperty label={m.tasks_blocking()} labelInChip>
            <TaskBlockingValue blocking={relations.detail.blocking} onOpen={onOpenRelated} />
          </TaskProperty>
        )}
      </dl>
      {relations.on && (
        <>
          <TaskPickerDialog
            open={picker === "parent"}
            onOpenChange={closePicker}
            task={task}
            rules={relations.parentRules}
            label={m.tasks_pick_parent()}
            parentsFor={currentMemberId}
            disabled={pending}
            onPick={(parent) => void relations.setParent(parent)}
          />
          <TaskPickerDialog
            open={picker === "blocker"}
            onOpenChange={closePicker}
            task={task}
            rules={relations.blockerRules}
            label={m.tasks_pick_blocker()}
            disabled={pending}
            onPick={(blocker) => void relations.addBlocker(blocker)}
          />
          <CreateTaskDialog
            open={picker === "subtask"}
            onOpenChange={closePicker}
            onCreate={relations.createSubtasks}
            describeError={(cause) => {
              const refusal = relationRefusal(cause);
              return refusal && errorText(refusal);
            }}
          />
          <SubtaskPickerDialog
            open={picker === "existing-subtask"}
            onOpenChange={closePicker}
            task={task}
            currentMemberId={currentMemberId}
            disabled={pending}
            onPick={(subtask) => void relations.adoptSubtask(subtask)}
          />
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-primary">
          {errorText(error)}
        </p>
      )}
    </section>
  );
}
