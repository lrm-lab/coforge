import { MAX_TASK_BLOCKERS, MAX_TASK_TREE_DEPTH, type TaskView } from "@lrm/coforge-sdk/internal";
import { useServerFn } from "@tanstack/react-start";
import { useState, type ComponentProps } from "react";

import type { Mentionable } from "#src/features/conversations/mention-text";
import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { CreateTaskDialog } from "./create-task-dialog";
import { TASK_ASSIGNMENT_MANAGER_REQUIRED } from "./task-assignment";
import { AssigneeMenu } from "./task-assignee-menu";
import { getTaskMoveCommand } from "./task-move";
import { TaskPickerDialog } from "./task-picker";
import { TaskProperty } from "./task-property";
import { openBlockers, relationRefusal, type VisibleTaskName } from "./task-relation-edits";
import { TaskBlockedByValue, TaskBlockingValue, TaskParentValue } from "./task-relation-lines";
import { TaskSourceLink } from "./task-source";
import { StatusMenu } from "./task-status-menu";
import { executeTask } from "./tasks.functions";
import { useTaskAssignmentAccess } from "./use-task-assignment-access";
import { useConversationTaskWrites } from "./use-conversation-tasks";
import { useTaskRelations, type DetailCommand } from "./use-task-relations";

/** What the header menu asked to add: a parent, a blocker or a sub-task, each picked in a dialog. */
export type RelationPicker = "parent" | "blocker" | "subtask";

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
  task,
  onCommand,
  members,
  currentMemberId,
  source,
  picker,
  onPickerChange,
  onOpenRelated,
}: {
  task: TaskView;
  onCommand?: (command: DetailCommand) => Promise<void>;
  members?: readonly Mentionable[];
  currentMemberId: string | null;
  /** The message the Task was made from, as a link back to it. */
  source?: ComponentProps<typeof TaskSourceLink>;
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
    <section className="flex flex-col gap-2 px-4 pt-3 sm:px-6">
      <h3 className="line-clamp-2 text-md font-semibold break-words text-primary">{task.title}</h3>
      <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
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
        <TaskProperty label={m.tasks_overview_owner()}>
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
        {relations.on && task.parent && (
          <TaskProperty label={m.tasks_parent()}>
            <TaskParentValue
              parent={task.parent}
              disabled={pending}
              onOpen={onOpenRelated}
              onClear={relations.canEdit ? () => void relations.clearParent() : undefined}
            />
          </TaskProperty>
        )}
        {relations.on && openBlockers(task.blockedBy).length > 0 && (
          <TaskProperty label={m.tasks_blocked_by()}>
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
          <TaskProperty label={m.tasks_blocking()}>
            <TaskBlockingValue blocking={relations.detail.blocking} onOpen={onOpenRelated} />
          </TaskProperty>
        )}
        {source && (
          <TaskProperty label={m.tasks_source()} className="sm:col-span-2">
            <TaskSourceLink {...source} />
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
