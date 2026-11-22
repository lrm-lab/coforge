import { TASK_WRITE_STATUSES, type TaskStatus } from "@lrm/coforge-sdk/internal";
import { FilterLines } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { PageHeader } from "#src/components/layout/page-header";
import { Skeleton } from "#src/components/ui/skeleton";
import { m } from "#src/paraglide/messages";
import { HIDDEN_COLUMN_CLASS } from "#src/features/settings/task-hidden-columns";
import { TaskStatusIcon, statusLabel } from "./task-status-icon";
import type { TaskLayout } from "./task-workflow";
import { cn } from "#src/lib/utils";

export function TaskCardSkeleton({ list }: { list: boolean }) {
  if (list)
    return (
      <div aria-hidden="true" className="flex h-10 items-center gap-3 px-4">
        <Skeleton className="h-3 w-7" />
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="ms-auto hidden h-6 w-20 rounded-full sm:block" />
        <Skeleton className="size-6 rounded-full" />
      </div>
    );
  return (
    <div aria-hidden="true" className="rounded-lg border border-secondary bg-primary p-3">
      <div className="flex h-6 items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="size-6 rounded-full" />
      </div>
      <Skeleton className="mt-2 h-3.5 w-11/12" />
      <Skeleton className="mt-2 h-3.5 w-3/5" />
    </div>
  );
}

const PLACEHOLDERS: Record<TaskStatus, number> = {
  backlog: 3,
  todo: 3,
  in_progress: 2,
  in_review: 2,
  done: 1,
  closed: 1,
};

export function TasksPending({ layout }: { layout?: TaskLayout }) {
  return (
    <main className="flex h-full max-h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary">
      <PageHeader
        heading={m.projects_title()}
        meta={<span className="text-lg text-tertiary">/ {m.projects_all_tasks()}</span>}
      />
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-3 px-page py-1.5">
        <Button size="sm" color="tertiary" iconLeading={FilterLines} className="-ms-3" isDisabled>
          {m.tasks_filter()}
        </Button>
      </div>
      <p role="status" className="sr-only">
        {m.tasks_loading()}
      </p>
      {layout ? (
        <PendingGroups board={layout === "board"} />
      ) : (
        <>
          <PendingGroups board className="hidden md:block" />
          <PendingGroups board={false} className="md:hidden" />
        </>
      )}
    </main>
  );
}

function PendingGroups({ board, className }: { board: boolean; className?: string }) {
  return (
    <div
      aria-busy="true"
      className={cn("min-h-0 flex-1 overflow-hidden px-page py-4 md:py-6", className)}
    >
      <div
        className={
          board
            ? "flex flex-col gap-3 md:h-full md:flex-row md:items-stretch md:justify-center-safe"
            : "flex flex-col gap-4"
        }
      >
        {TASK_WRITE_STATUSES.map((status) => (
          <section
            key={status}
            aria-label={statusLabel(status)}
            className={
              board
                ? cn(
                    "flex min-w-0 flex-col rounded-xl bg-secondary md:max-w-80 md:min-w-60 md:flex-1",
                    HIDDEN_COLUMN_CLASS[status],
                  )
                : "min-w-0 overflow-hidden rounded-xl border border-secondary bg-primary"
            }
          >
            <div
              className={
                board
                  ? "flex h-10 items-center gap-2 px-3 text-sm font-semibold text-primary"
                  : "flex h-10 items-center gap-2 border-b border-secondary bg-secondary px-4 text-sm font-semibold text-primary"
              }
            >
              <TaskStatusIcon status={status} />
              {statusLabel(status)}
              <Skeleton className="h-3.5 w-4 bg-tertiary" />
            </div>
            <div
              className={
                board ? "flex flex-col gap-2 px-2 pb-2" : "flex flex-col divide-y divide-secondary"
              }
            >
              {Array.from({ length: PLACEHOLDERS[status] }, (_, index) => (
                <TaskCardSkeleton key={index} list={!board} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
