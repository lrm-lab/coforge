import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  ProjectTaskTreeSkeleton,
  ProjectTaskTreeView,
} from "#src/features/projects/project-task-tree";
import { useProjectTasks } from "#src/features/projects/project-tasks";
import { TaskBoard } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import { TASK_TITLE_CLASS } from "./task-card";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";
import { overviewTaskParam, parseOverviewTaskParam } from "./task-overview-search";
import { useTaskOverview } from "./use-task-overview";
import { overviewTaskQuery, useFinishedTasks } from "./use-finished-tasks";

const OverviewTaskPopup = lazy(() =>
  import("./overview-task-popup").then((module) => ({
    default: module.OverviewTaskPopup,
  })),
);

type BoardSearch = Parameters<typeof useTaskBoardSearch>[0] & { task?: string };

export function WorkspaceTaskBoard({
  search,
  project,
  projectSlug,
  board = true,
}: {
  search: BoardSearch;
  project?: string;
  projectSlug?: string;
  board?: boolean;
}) {
  const { tasks: all, run, refetch } = useTaskOverview();
  const { task: taskParam, ...boardSearch } = search;
  const searched = useTaskBoardSearch(boardSearch);
  const hydrated = useHydrated();
  const layoutPending = project !== undefined && boardSearch.layout === undefined && !hydrated;
  const treeShown = project !== undefined && !layoutPending && searched.layout === "list";
  const projectTasks = useProjectTasks(treeShown ? project : undefined);
  const view = useMemo(
    () => (treeShown ? searched : { ...searched, filter: { ...searched.filter, channels: [] } }),
    [treeShown, searched],
  );
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const router = useRouter();
  const projectPick = useMemo(
    () => (project ? [project] : view.filter.projects),
    [project, view.filter.projects],
  );
  const tasks = useMemo(
    () =>
      all.filter(
        (task) =>
          (!project || task.project?.id === project) &&
          !(
            task.parentProjectId !== undefined &&
            (projectPick.length === 0 || projectPick.includes(task.parentProjectId ?? "none"))
          ),
      ),
    [all, project, projectPick],
  );
  const finished = useFinishedTasks({
    scope: { workspaceId },
    window: view.completedWindow,
    filter: project ? { ...view.filter, projects: [project] } : view.filter,
    onPage: tasks,
    enabled: !treeShown,
  });
  const { refresh: refreshFinished } = finished;
  const command = useMemo(
    () =>
      run
        ? (task: OverviewTaskRow, input: OverviewTaskCommand) =>
            run(task, input).finally(refreshFinished)
        : undefined,
    [run, refreshFinished],
  );

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
  const lookup = useQuery(overviewTaskQuery(workspaceId, taskRef));
  const openTask = taskRef ? (lookup.data ?? listed) : undefined;
  const openConversationId = openTask?.conversationId;
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
  const newTask = useMemo(
    () => ({ projectSlug, onCreated: refreshOverview }),
    [projectSlug, refreshOverview],
  );
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
          commandsPending={!hydrated}
          project={project !== undefined}
          newTask={newTask}
          tree={
            treeShown
              ? {
                  node: (
                    <ProjectTaskTreeView query={projectTasks} view={view} onOpenTask={openPopup} />
                  ),
                  tasks: projectTasks.data?.tasks ?? [],
                }
              : layoutPending
                ? { node: <ProjectTaskTreeSkeleton />, tasks: [] }
                : undefined
          }
        />
      )}
      {openTask && (
        <Suspense fallback={null}>
          <OverviewTaskPopup
            key={openTask.conversationId}
            task={openTask}
            onOpenTask={openConversationTask}
            onOpenTaskIn={openPopup}
            onClose={closePopup}
            onCommand={(input) => (command ? command(openTask, input) : Promise.resolve())}
            onTaskChanged={refreshOverview}
          />
        </Suspense>
      )}
    </>
  );
}

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
