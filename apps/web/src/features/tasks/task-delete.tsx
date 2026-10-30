import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useServerFn } from "@tanstack/react-start";
import { Trash01 } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { m } from "#src/paraglide/messages";
import { useCanSetAnyTaskStatus } from "./task-board-authority";
import { executeTask } from "./tasks.functions";
import { useConversationTaskWrites } from "./use-conversation-tasks";

/** Whether the viewer may delete the Task, as the server allows: its creator, or a Workspace owner
 * or admin. Only an affordance; the server rechecks. */
export function useCanDeleteTask(task: TaskView, currentMemberId: string | null): boolean {
  const manager = useCanSetAnyTaskStatus();
  return manager || (currentMemberId !== null && task.creator.memberId === currentMemberId);
}

/** Confirms, then deletes the Task by its conversation and number (never a host message, which a
 * Task need not have), through the caller's task command where there is one (the Tasks page's
 * drops the row), and drops it from the conversation's Tasks. */
export function TaskDeleteDialog({
  task,
  open,
  onOpenChange,
  onCommand,
  onDeleted,
}: {
  task: TaskView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCommand?: (command: { operation: "delete"; number: number }) => Promise<void>;
  onDeleted?: () => void;
}) {
  const execute = useServerFn(executeTask);
  const writeTasks = useConversationTaskWrites();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.tasks_delete_title({ number: String(task.number) })}
      description={m.tasks_delete_description()}
      confirmLabel={m.tasks_delete()}
      pendingLabel={m.tasks_deleting()}
      errorMessage={m.tasks_delete_failed()}
      onConfirm={async () => {
        const command = { operation: "delete", number: task.number } as const;
        if (onCommand) await onCommand(command);
        else
          await execute({
            data: {
              ...command,
              idempotencyKey: crypto.randomUUID(),
              conversationId: task.conversationId,
            },
          });
        writeTasks(task.conversationId, [{ tasks: [], deleted: [task.id] }]);
        onOpenChange(false);
        onDeleted?.();
      }}
    />
  );
}

/** The menu's "Delete Task" item: red text, as every destructive menu item
 * (docs/design/color-status-typography.md). */
export function taskDeleteMenuItem() {
  return (
    <Dropdown.Item id="delete" textValue={m.tasks_delete()}>
      <span className="flex items-center text-error-primary">
        <Trash01 aria-hidden="true" className="mr-2 size-4 shrink-0 stroke-[2.25px]" />
        {m.tasks_delete()}
      </span>
    </Dropdown.Item>
  );
}
