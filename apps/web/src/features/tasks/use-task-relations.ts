import { taskNameLabel, type TaskCommand, type TaskView } from "@lrm/coforge-sdk/internal";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";

import { useCanSetAnyTaskStatus } from "./task-board-authority";
import {
  blockerPickerRules,
  blockerRefs,
  canAddBlocker,
  canEditTaskRelations,
  parentPickerRules,
  taskRefOf,
  type TaskDetailRelations,
  type VisibleTaskName,
} from "./task-relation-edits";
import { executeTask } from "./tasks.functions";
import { useTaskConversationsOn } from "./use-task-conversations-on";
import { useConversationTaskWrites } from "./use-conversation-tasks";

/** A Task command as the popup issues it: the conversation comes from the Task. */
export type DetailCommand = Omit<TaskCommand, "idempotencyKey" | "conversationId"> & {
  number: number;
};

const NO_DETAIL: TaskDetailRelations = { blocking: [], subtree: [] };

/**
 * Whether the popup offers a Task's dependencies and sub-tasks at all (the Workspace has Tasks v2
 * on; unknown counts as off, so nothing shows and nothing is read before it is known), and
 * whether this viewer may change them. Only an affordance: the server rechecks every write.
 */
export function useTaskRelationAccess(
  task: Pick<TaskView, "owner" | "creator" | "blockedBy">,
  currentMemberId: string | null,
) {
  const on = useTaskConversationsOn() === true;
  const manager = useCanSetAnyTaskStatus();
  const canEdit = on && canEditTaskRelations(task, currentMemberId, manager);
  return { on, canEdit, canAddBlocker: canEdit && canAddBlocker(task.blockedBy) };
}

/**
 * What only `show` reads of a Task: the Tasks waiting for it and its whole sub-task tree. Keyed by
 * revision like History, plus what the Task's own copy shows of its neighbours: a sub-task
 * finishing or a blocker's status changes announce a new copy of this Task (its progress and
 * blockers) without moving its revision.
 */
export function useTaskShow(task: TaskView, enabled: boolean): TaskDetailRelations {
  const execute = useServerFn(executeTask);
  const { conversationId, number } = task;
  const detail = useQuery({
    queryKey: [
      "task",
      "show",
      conversationId,
      number,
      task.revision,
      task.blockedBy,
      task.parent,
      task.subtasks,
    ],
    queryFn: async (): Promise<TaskDetailRelations> => {
      const result = await execute({
        data: { operation: "show", idempotencyKey: crypto.randomUUID(), conversationId, number },
      });
      return { blocking: result.blocking ?? [], subtree: result.subtree ?? [] };
    },
    enabled,
    placeholderData: (previous) => previous,
  });
  return detail.data ?? NO_DETAIL;
}

/**
 * The Task popup's dependencies and sub-tasks: what `show` adds to the Task's own view (the Tasks
 * waiting for it and its sub-task tree), the picker rules, and the commands that change them.
 * `run` is the popup's command path, which owns the pending state and the refusal line; creating
 * sub-tasks runs here, since its dialog reuses one idempotency key across retries.
 */
export function useTaskRelations({
  task,
  currentMemberId,
  run,
}: {
  task: TaskView;
  currentMemberId: string | null;
  /** `subject`: the picked Task the change is about, which a refusal names. */
  run: (command: DetailCommand, subject?: string) => Promise<void>;
}) {
  const access = useTaskRelationAccess(task, currentMemberId);
  const execute = useServerFn(executeTask);
  const writeTasks = useConversationTaskWrites();
  const queryClient = useQueryClient();
  const { conversationId, number } = task;
  const shown = useTaskShow(task, access.on);
  const blockerRules = useMemo(() => blockerPickerRules(task, shown), [task, shown]);
  const parentRules = useMemo(() => parentPickerRules(task, shown), [task, shown]);

  // An amendment replaces the whole set, so a change to it carries the revision it was made
  // against: another person's change since is refused rather than overwritten.
  const amendBlockers = (change: { add?: VisibleTaskName; remove?: VisibleTaskName }) => {
    const refs = blockerRefs(task.blockedBy, change);
    if (!refs) return Promise.resolve();
    const subject = change.add ?? change.remove;
    return run(
      { operation: "amend", number, blockedBy: refs, expectedRevision: task.revision },
      subject && taskNameLabel(subject),
    );
  };

  return {
    ...access,
    detail: shown,
    blockerRules,
    parentRules,
    addBlocker: (blocker: VisibleTaskName) => amendBlockers({ add: blocker }),
    removeBlocker: (blocker: VisibleTaskName) => amendBlockers({ remove: blocker }),
    setParent: (parent: VisibleTaskName) =>
      run({ operation: "amend", number, parent: taskRefOf(parent) }, taskNameLabel(parent)),
    clearParent: () => run({ operation: "amend", number, parent: null }),
    /** Puts an existing Task of this conversation under this one (task #505): the amendment is
     * the sub-task's, its parent set to this Task. This Task's tree is read again after. */
    adoptSubtask: async (subtask: VisibleTaskName) => {
      await run(
        { operation: "amend", number: subtask.number, parent: { number } },
        taskNameLabel(subtask),
      );
      await queryClient.invalidateQueries({ queryKey: ["task", "show", conversationId, number] });
    },
    /** Creates the sub-tasks together, in this Task's conversation, under this Task. */
    createSubtasks: async (titles: string[], idempotencyKey: string) => {
      const result = await execute({
        data: {
          operation: "create",
          titles,
          parent: { number },
          idempotencyKey,
          conversationId,
        },
      });
      writeTasks(conversationId, [{ tasks: result.tasks, deleted: [] }]);
      // This Task's progress and tree changed; its own copy follows by announcement.
      await queryClient.invalidateQueries({ queryKey: ["task", "show", conversationId, number] });
    },
  };
}
