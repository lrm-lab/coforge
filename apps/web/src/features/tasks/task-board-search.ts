import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import type { FinishedWindow } from "./finished-tasks";
import { filterParam, parseFilterParam, parseStatusParam, type TaskFilter } from "./task-filters";
import { useTaskLayout, type TaskLayout } from "./task-workflow";

/**
 * A conversation's Task board view in the address: the status picks, the layout, the owner picks
 * (comma-separated User or Agent ids, `none` for nobody) and how far back Done and Closed reach
 * (a week when absent). Every conversation page host spreads it (through
 * `conversationPageSearchShape`) into its `validateSearch`.
 */
export const conversationTaskBoardSearchShape = {
  /** Statuses, comma-separated (task #506); a single status is the same address as before. */
  status: z.string().optional().catch(undefined),
  layout: z.enum(["board", "list"]).optional().catch(undefined),
  owners: z.string().optional().catch(undefined),
  /** Label ids, comma-separated, or `none` for the Tasks with no label (task #455). */
  labels: z.string().optional().catch(undefined),
  completed: z.enum(["month", "all"]).optional().catch(undefined),
};

/** The Tasks page's board view: a conversation's, plus the Project picks (Project ids, `none` for
 * no Project), since the page mixes Projects. */
export const taskBoardSearchShape = {
  ...conversationTaskBoardSearchShape,
  projects: z.string().optional().catch(undefined),
};

type TaskBoardSearch = z.infer<z.ZodObject<typeof taskBoardSearchShape>>;

/** A board's view as the board reads it, and how it changes it. */
export type TaskBoardView = ReturnType<typeof useTaskBoardSearch>;

/**
 * The board's view read from the address, and changes written back to it. Shared by the Tasks
 * page and every conversation page host (Chat's routes, the search preview), so it navigates
 * relative to the current route (`to: "."`) rather than through one route's typed API; each
 * route validates the result.
 */
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
    // A layout is a history entry; picks (statuses included) and the window replace the address in
    // place, so Back leaves the board rather than undoing each pick.
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
      // A status pick is a pick like the others: it replaces the address in place.
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
