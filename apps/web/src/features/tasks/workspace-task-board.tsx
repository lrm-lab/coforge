import { Link, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { OverviewTaskPopup } from "./overview-task-popup";
import { TaskBoard } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import { TASK_TITLE_CLASS } from "./task-card";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";
import { overviewTaskParam, parseOverviewTaskParam } from "./task-overview-search";
import { useTaskOverview } from "./use-task-overview";
import { overviewTaskQuery, useFinishedTasks } from "./use-finished-tasks";

type BoardSearch = Parameters<typeof useTaskBoardSearch>[0] & { task?: string };

/**
 * The Workspace's Task board with each Task's popup over it (`task` in the address): the Tasks
 * page, and a Project page's Tasks tab (`project`), which shows only that Project's Tasks and
 * offers no Project to pick. It navigates relative to the current route (`to: "."`), so either
 * route's `validateSearch` takes what it writes.
 */
export function WorkspaceTaskBoard({
  search,
  project,
  board = true,
}: {
  search: BoardSearch;
  project?: string;
  /** False where only the popup is wanted: a Project page's other tabs and its phone list. */
  board?: boolean;
}) {
  const { tasks: all, run, refetch } = useTaskOverview();
  const { task: taskParam, ...boardSearch } = search;
  const view = useTaskBoardSearch(boardSearch);
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const router = useRouter();
  const tasks = useMemo(
    () => (project ? all.filter((task) => task.project?.id === project) : all),
    [all, project],
  );
  const finished = useFinishedTasks({
    scope: { workspaceId },
    window: view.completedWindow,
    // A Project's board pages its own Done and Closed; its view never names a Project.
    filter: project ? { ...view.filter, projects: [project] } : view.filter,
    onPage: tasks,
  });
  const { refresh: refreshFinished } = finished;
  // A move shows at once and takes the server's copy of the Task; a refused one is back in place.
  // Done and Closed are counted and paged by the server, so they are read again after each.
  const command = useMemo(
    () =>
      run
        ? (task: OverviewTaskRow, input: OverviewTaskCommand) =>
            run(task, input).finally(refreshFinished)
        : undefined,
    [run, refreshFinished],
  );

  // Every Task the page has read: the unfinished ones and the opened pages of Done and Closed.
  const known = useMemo(
    () => [...tasks, ...finished.columns.done.rows, ...finished.columns.closed.rows],
    [tasks, finished.columns.done.rows, finished.columns.closed.rows],
  );
  const taskRef = useMemo(() => parseOverviewTaskParam(taskParam), [taskParam]);
  const listed = useMemo(
    () =>
      taskRef
        ? known.find(
            (task) =>
              task.conversationId === taskRef.conversationId && task.number === taskRef.number,
          )
        : undefined,
    [taskRef, known],
  );
  // A Task `task` names that the page has not read (a finished one past the opened pages, or one
  // created since the page loaded), read on its own. It sits with the finished-work reads, so the
  // reads after each command and announcement refresh it too.
  const lookup = useQuery(overviewTaskQuery(workspaceId, listed ? undefined : taskRef));
  // The Task whose popup `task` names.
  const openTask = listed ?? (taskRef && !listed ? (lookup.data ?? undefined) : undefined);
  const openConversationId = openTask?.conversationId;
  // Opening a popup is a history entry, so Back closes it; closing replaces in place.
  const setTask = useCallback(
    (task: string | undefined, replace: boolean) =>
      void router.navigate({
        to: ".",
        replace,
        resetScroll: false,
        search: (previous: Record<string, unknown>) => ({ ...previous, task }),
      }),
    [router],
  );
  const openPopup = useCallback(
    (task: { conversationId: string; number: number }) => setTask(overviewTaskParam(task), false),
    [setTask],
  );
  const openConversationTask = useCallback(
    (number: number) => {
      if (openConversationId) openPopup({ conversationId: openConversationId, number });
    },
    [openConversationId, openPopup],
  );
  const closePopup = useCallback(() => setTask(undefined, true), [setTask]);
  const refreshOverview = useCallback(() => {
    void refetch();
    refreshFinished();
  }, [refetch, refreshFinished]);
  // A `task` that cannot be read (deleted, in a conversation this viewer cannot see, or gone on
  // a later read) opens nothing, so it leaves the URL rather than lingering there.
  const missing =
    taskParam !== undefined &&
    !listed &&
    (!taskRef || lookup.isError || (lookup.isSuccess && lookup.data === null));
  useEffect(() => {
    if (missing) closePopup();
  }, [missing, closePopup]);

  return (
    <>
      {board && (
        <TaskBoard
          tasks={tasks}
          finished={finished}
          view={view}
          onOpenTask={openPopup}
          renderTitle={renderTaskTitle}
          onCommand={command}
          project={project !== undefined}
        />
      )}
      {openTask && (
        <OverviewTaskPopup
          // One conversation per popup instance: another Task of the same conversation keeps it.
          key={openTask.conversationId}
          task={openTask}
          onOpenTask={openConversationTask}
          onOpenTaskIn={openPopup}
          onClose={closePopup}
          onCommand={(input) => (command ? command(openTask, input) : Promise.resolve())}
          onTaskChanged={refreshOverview}
        />
      )}
    </>
  );
}

/** A card's title opens its Task's popup over the page; a link, so the popup's URL can also open
 * in a new tab. */
function renderTaskTitle(task: OverviewTaskRow, title: ReactNode) {
  return (
    <Link
      to="."
      search={(previous: Record<string, unknown>) => ({
        ...previous,
        task: overviewTaskParam(task),
      })}
      resetScroll={false}
      className={TASK_TITLE_CLASS}
    >
      {title}
    </Link>
  );
}
