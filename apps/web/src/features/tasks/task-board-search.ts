import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import type { FinishedWindow } from "./finished-tasks";
import { filterParam, parseFilterParam, parseStatusParam, type TaskFilter } from "./task-filters";
import { useTaskLayout, type TaskLayout } from "./task-workflow";

const baseTaskBoardSearchShape = {
  status: z.string().optional().catch(undefined),
  layout: z.enum(["board", "list"]).optional().catch(undefined),
  owners: z.string().optional().catch(undefined),
  labels: z.string().optional().catch(undefined),
  completed: z.enum(["month", "all"]).optional().catch(undefined),
};

export const taskBoardSearchShape = {
  ...baseTaskBoardSearchShape,
  projects: z.string().optional().catch(undefined),
};

export const projectTaskBoardSearchShape = {
  ...baseTaskBoardSearchShape,
};

type TaskBoardSearch = z.infer<z.ZodObject<typeof taskBoardSearchShape>>;

export type TaskBoardView = ReturnType<typeof useTaskBoardSearch>;

export function useTaskBoardSearch(search: TaskBoardSearch) {
  const router = useRouter();
  const layout = useTaskLayout(search.layout);
  const { owners, projects, labels, status, completed } = search;
  const statuses = useMemo(() => parseStatusParam(status), [status]);
  const filter = useMemo<TaskFilter>(
    () => ({
      owners: parseFilterParam(owners),
      projects: parseFilterParam(projects),
      labels: parseFilterParam(labels),
    }),
    [owners, projects, labels],
  );
  const completedWindow: FinishedWindow = completed ?? "week";
  return useMemo(() => {
    const update = (patch: TaskBoardSearch, replace: boolean) =>
      void router.navigate({
        to: ".",
        replace,
        resetScroll: false,
        search: (previous: TaskBoardSearch) => ({ ...previous, ...patch }),
      });
    return {
      statuses,
      layout,
      filter,
      completedWindow,
      changeStatuses: (next: readonly TaskStatus[]) =>
        update({ status: filterParam(parseStatusParam(next.join(","))) }, true),
      changeLayout: (next: TaskLayout) => update({ layout: next }, false),
      changeFilter: (next: TaskFilter) =>
        update(
          {
            owners: filterParam(next.owners),
            projects: filterParam(next.projects),
            labels: filterParam(next.labels),
          },
          true,
        ),
      changeWindow: (next: FinishedWindow) =>
        update({ completed: next === "week" ? undefined : next }, true),
    };
  }, [router, statuses, layout, filter, completedWindow]);
}
