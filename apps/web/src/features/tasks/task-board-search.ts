import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { useRouter } from "@tanstack/react-router";
import { useMemo } from "react";
import { z } from "zod";

import type { FinishedWindow } from "./finished-tasks";
import { filterParam, parseFilterParam, parseStatusParam, type TaskFilter } from "./task-filters";
import { useTaskLayout, type TaskLayout } from "./task-workflow";

/**
 * What every Task board keeps in the address: the status picks, the layout, the owner and label
 * picks (comma-separated ids, `none` for nobody or no label) and how far back Done and Closed
 * reach (a week when absent). Each board adds the picks it offers below.
 */
const baseTaskBoardSearchShape = {
  /** Statuses, comma-separated (task #506); a single status is the same address as before. */
  status: z.string().optional().catch(undefined),
  layout: z.enum(["board", "list"]).optional().catch(undefined),
  owners: z.string().optional().catch(undefined),
  /** Label ids, comma-separated, or `none` for the Tasks with no label (task #455). */
  labels: z.string().optional().catch(undefined),
  completed: z.enum(["month", "all"]).optional().catch(undefined),
};

/** The Tasks page's and every conversation's board view: the Project picks (Project ids, `none`
 * for no Project), since their Tasks can be under any Project (task #484). Every conversation
 * page host spreads it (through `conversationPageSearchShape`) into its `validateSearch`. */
export const taskBoardSearchShape = {
  ...baseTaskBoardSearchShape,
  projects: z.string().optional().catch(undefined),
};

/** A Project page's board view: no Project picks (the page names it), but the channel picks
 * (conversation ids) its task tree offers (task #462), since a Project spans conversations. */
export const projectTaskBoardSearchShape = {
  ...baseTaskBoardSearchShape,
  channels: z.string().optional().catch(undefined),
};

type TaskBoardSearch = z.infer<
  z.ZodObject<typeof taskBoardSearchShape & typeof projectTaskBoardSearchShape>
>;

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
  const { owners, projects, labels, channels, status, completed } = search;
  const statuses = useMemo(() => parseStatusParam(status), [status]);
  const filter = useMemo<TaskFilter>(
    () => ({
      owners: parseFilterParam(owners),
      projects: parseFilterParam(projects),
      labels: parseFilterParam(labels),
      channels: parseFilterParam(channels),
    }),
    [owners, projects, labels, channels],
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
      // Only the list (a Project's task tree) picks channels; the board drops them.
      changeLayout: (next: TaskLayout) =>
        update({ layout: next, ...(next === "board" && { channels: undefined }) }, false),
      changeFilter: (next: TaskFilter) =>
        update(
          {
            owners: filterParam(next.owners),
            projects: filterParam(next.projects),
            labels: filterParam(next.labels),
            channels: filterParam(next.channels ?? []),
          },
          true,
        ),
      changeWindow: (next: FinishedWindow) =>
        update({ completed: next === "week" ? undefined : next }, true),
    };
  }, [router, statuses, layout, filter, completedWindow]);
}
