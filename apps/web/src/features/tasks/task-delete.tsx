import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash01 } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { useAppToast } from "#src/components/ui/toast";
import { isAppErrorCode } from "#src/lib/app-error";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import { useCanSetAnyTaskStatus } from "./task-board-authority";
import { refreshTaskOverview } from "./task-overview-collection";
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
 * drops the row), and drops it from the conversation's Tasks. A toast then offers Undo for a short
 * while (Frank, 11-04, task #507): the server keeps a deleted Task restorable for a minute
 * (`DELETED_TASK_UNDO_MS`, task #512), and Undo brings it back whole. */
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
  onCommand?: (command: { operation: "delete" | "restore"; number: number }) => Promise<void>;
  onDeleted?: () => void;
}) {
  const execute = useServerFn(executeTask);
  const writeTasks = useConversationTaskWrites();
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  // Undo goes the way the delete went: through the caller's command (the Tasks page's puts the row
  // back), or straight to the server and into the conversation's Tasks.
  const restore = async () => {
    const command = { operation: "restore", number: task.number } as const;
    try {
      if (onCommand) return await onCommand(command);
      const result = await execute({
        data: {
          ...command,
          idempotencyKey: crypto.randomUUID(),
          conversationId: task.conversationId,
        },
      });
      writeTasks(task.conversationId, [{ tasks: result.tasks ?? [], deleted: [] }]);
      // The Tasks page lists it too, and its popup deletes this way, not through its commands.
      refreshTaskOverview(queryClient, workspaceId);
    } catch (cause) {
      toast.error(
        isAppErrorCode(cause, "CONFLICT") && cause.errorId === "task-restore-window-elapsed"
          ? m.tasks_restore_expired()
          : m.tasks_restore_failed(),
      );
    }
  };
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
        toast.success(m.tasks_deleted_toast({ number: String(task.number) }), {
          key: task.id,
          durationMs: UNDO_WINDOW_MS,
          action: { label: m.action_undo(), onClick: () => void restore() },
        });
      }}
    />
  );
}

/** How long the Undo stays: about ten seconds, as Frank asked (11-04), well inside the server's
 * minute. */
const UNDO_WINDOW_MS = 10_000;

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
