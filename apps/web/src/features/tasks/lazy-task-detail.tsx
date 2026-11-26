import { lazy, Suspense, type ComponentProps } from "react";

import { Skeleton } from "#src/components/ui/skeleton";
import type { TaskDetailDialog } from "./task-detail-dialog";
import type { TaskDetailPanel } from "./task-detail-panel";

const LazyTaskDetailPanelInner = lazy(() =>
  import("./task-detail-panel").then((mod) => ({ default: mod.TaskDetailPanel })),
);

const LazyTaskDetailDialogInner = lazy(() =>
  import("./task-detail-dialog").then((mod) => ({ default: mod.TaskDetailDialog })),
);

function TaskPanelFallback() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 bg-primary p-5">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  );
}

export function LazyTaskDetailPanel(props: ComponentProps<typeof TaskDetailPanel>) {
  return (
    <Suspense fallback={<TaskPanelFallback />}>
      <LazyTaskDetailPanelInner {...props} />
    </Suspense>
  );
}

export function LazyTaskDetailDialog(props: ComponentProps<typeof TaskDetailDialog>) {
  return (
    <Suspense fallback={null}>
      <LazyTaskDetailDialogInner {...props} />
    </Suspense>
  );
}
