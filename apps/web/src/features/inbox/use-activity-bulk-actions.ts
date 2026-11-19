import { useMemo } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { markActivityAllDone, undoActivityDone } from "./activity-inbox.functions";
import {
  cancelActivityInboxListReads,
  optimisticallyCompleteActivityItems,
  type ActivityCompletionItem,
} from "./activity-inbox-queries";
import type { ActivityDoneUndo } from "./activity-inbox.schemas";

export function useActivityBulkActions({
  workspaceId,
  onChanged,
  onFailure,
  onDoneStarted,
  onDoneSettled,
}: {
  workspaceId: string;
  onChanged: () => Promise<void>;
  onFailure: (failure: { retry: () => void } | null) => void;
  onDoneStarted: (item: ActivityCompletionItem) => void;
  onDoneSettled: (item: ActivityCompletionItem) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useAppToast();
  const doneAll = useServerFn(markActivityAllDone);
  const undoDone = useServerFn(undoActivityDone);

  return useMemo(() => {
    function run(action: () => Promise<unknown>, rows: ActivityCompletionItem[] = []) {
      onFailure(null);
      rows.forEach(onDoneStarted);
      optimisticallyCompleteActivityItems(queryClient, workspaceId, rows);
      void Promise.resolve()
        .then(action)
        .catch(() => onFailure({ retry: () => run(action, rows) }))
        .finally(async () => {
          try {
            await onChanged();
          } finally {
            rows.forEach(onDoneSettled);
          }
        });
    }

    function offerUndo(done: { count: number; undo: ActivityDoneUndo | null }) {
      if (done.count === 0) return;
      const { undo } = done;
      const title = m.activity_bulk_marked_done({ count: done.count });
      const key = String(Date.now());
      if (undo === null) {
        toast.success(title, { key });
        return;
      }
      toast.undoable(title, {
        key,
        failed: m.activity_inbox_action_error(),
        onUndo: () => undoDone({ data: undo }).finally(onChanged),
      });
    }

    return {
      doneAll: (before: number, items: readonly ActivityCompletionItem[]) =>
        run(async () => {
          await cancelActivityInboxListReads(queryClient, workspaceId);
          offerUndo(await doneAll({ data: { before } }));
        }, [...items]),
    };
  }, [
    queryClient,
    workspaceId,
    toast,
    onChanged,
    onFailure,
    onDoneStarted,
    onDoneSettled,
    doneAll,
    undoDone,
  ]);
}
