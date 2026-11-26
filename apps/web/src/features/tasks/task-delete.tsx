import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Trash01 } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { useAppToast } from "#src/components/ui/toast";
import { isAppErrorCode } from "#src/lib/app-error";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { m } from "#src/paraglide/messages";
import { useCanSetAnyTaskStatus } from "./task-board-authority";
import { refreshTaskOverview } from "./task-overview-collection";
import { executeTask } from "./tasks.functions";
import { useConversationTaskWrites } from "./use-conversation-tasks";

export function useCanDeleteTask(task: TaskView, currentMemberId: string | null): boolean {
  const manager = useCanSetAnyTaskStatus();
  return manager || (currentMemberId !== null && task.creator.memberId === currentMemberId);
}

export function useDeleteTask({
  task,
  onCommand,
  onDeleted,
}: {
  task: TaskView;
  onCommand?: (command: { operation: "delete" | "restore"; number: number }) => Promise<void>;
  onDeleted?: () => void;
}) {
  const execute = useServerFn(executeTask);
  const writeTasks = useConversationTaskWrites();
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const restore = async () => {
    const command = { operation: "restore", number: task.number } as const;
    if (onCommand) return onCommand(command);
    const result = await execute({
      data: {
        ...command,
        idempotencyKey: crypto.randomUUID(),
        conversationId: task.conversationId,
      },
    });
    writeTasks(task.conversationId, [{ tasks: result.tasks ?? [], deleted: [] }]);
    refreshTaskOverview(queryClient, workspaceId);
  };
  return async () => {
    const command = { operation: "delete", number: task.number } as const;
    try {
      if (onCommand) await onCommand(command);
      else
        await execute({
          data: {
            ...command,
            idempotencyKey: crypto.randomUUID(),
            conversationId: task.conversationId,
          },
        });
    } catch {
      toast.error(m.tasks_delete_failed());
      return;
    }
    writeTasks(task.conversationId, [{ tasks: [], deleted: [task.id] }]);
    onDeleted?.();
    toast.undoable(m.tasks_deleted_toast({ number: String(task.number) }), {
      key: task.id,
      durationMs: UNDO_WINDOW_MS,
      onUndo: restore,
      failed: (cause) =>
        isAppErrorCode(cause, "CONFLICT") && cause.errorId === "task-restore-window-elapsed"
          ? m.tasks_restore_expired()
          : m.tasks_restore_failed(),
    });
  };
}

const UNDO_WINDOW_MS = 10_000;

export function taskDeleteMenuItem() {
  return <Dropdown.Item id="delete" icon={Trash01} label={m.tasks_delete()} tone="destructive" />;
}
