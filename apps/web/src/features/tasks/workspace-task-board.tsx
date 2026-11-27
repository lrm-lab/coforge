import { Link, useHydrated, useRouter } from "@tanstack/react-router";
import { Suspense, lazy, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Group, Panel, Separator, useDefaultLayout, useGroupRef } from "react-resizable-panels";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import {
  SIDE_PANE_ENTER,
  useResponsiveSplitLayout,
} from "#src/features/conversations/conversation-split";
import { localLayoutStorage } from "#src/features/conversations/local-layout-storage";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { isFinishedStatus } from "./finished-tasks";
import { TaskBoard, orderBoardTasks } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import { TASK_TITLE_CLASS } from "./task-card";
import type { TaskDetailNavigation } from "./task-detail-panel";
import { statusMatches, taskMatches } from "./task-filters";
import type { OverviewTaskCommand, OverviewTaskRow } from "./task-overview-collection";
import { overviewTaskParam, parseOverviewTaskParam } from "./task-overview-search";
import { useTaskOverview } from "./use-task-overview";
import { overviewTaskQuery, useFinishedTasks } from "./use-finished-tasks";

const OverviewTaskPopup = lazy(() =>
  import("./overview-task-popup").then((module) => ({
    default: module.OverviewTaskPopup,
  })),
);

const BOARD_MIN_REM = 26;
const TASK_PANE_MIN_REM = 24;
const TASK_PANE_DEFAULT_PCT = 40;

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
  const view = useTaskBoardSearch(boardSearch);
  const hydrated = useHydrated();
  const desktop = useBreakpoint("lg");
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
    enabled: board,
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
  const [expanded, setExpanded] = useState(false);
  const isExpanded = Boolean(openTask) && expanded;

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
  const switchPopup = useCallback(
    (task: { conversationId: string; number: number }) => setTask(overviewTaskParam(task), true),
    [setTask],
  );
  const openConversationTask = useCallback(
    (number: number) => {
      if (openConversationId) openPopup({ conversationId: openConversationId, number });
    },
    [openConversationId, openPopup],
  );
  const closePopup = useCallback(() => {
    setExpanded(false);
    setTask(undefined, true);
  }, [setTask]);
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

  const orderedTasks = useMemo(() => {
    if (!openTask) return [];
    const unfinished = tasks.filter((task) => !isFinishedStatus(task.status));
    const visible = [
      ...unfinished,
      ...finished.columns.done.rows,
      ...finished.columns.closed.rows,
    ].filter((task) => statusMatches(task.status, view.statuses) && taskMatches(task, view.filter));
    return orderBoardTasks(visible, view.statuses);
  }, [
    openTask,
    tasks,
    finished.columns.done.rows,
    finished.columns.closed.rows,
    view.statuses,
    view.filter,
  ]);

  const navigation = useMemo<TaskDetailNavigation | undefined>(() => {
    if (!openTask || orderedTasks.length === 0) return undefined;
    const index = orderedTasks.findIndex(
      (candidate) =>
        candidate.conversationId === openTask.conversationId &&
        candidate.number === openTask.number,
    );
    if (index < 0) return undefined;
    const prev = orderedTasks[index - 1];
    const next = orderedTasks[index + 1];
    return {
      hasPrev: Boolean(prev),
      hasNext: Boolean(next),
      onPrev: () => {
        if (prev) switchPopup(prev);
      },
      onNext: () => {
        if (next) switchPopup(next);
      },
    };
  }, [openTask, orderedTasks, switchPopup]);

  const groupRef = useGroupRef();
  const splitLayout = useDefaultLayout({
    id: "coforge-task-board-split",
    panelIds: openTask ? ["board", "task"] : ["board"],
    onlySaveAfterUserInteractions: true,
    storage: localLayoutStorage,
  });
  const { splitRef, splitShown } = useResponsiveSplitLayout({
    active: board && desktop && Boolean(openTask) && !isExpanded,
    mainMinRem: BOARD_MIN_REM,
    sideMinRem: TASK_PANE_MIN_REM,
  });
  const useInlineSplit = board && desktop && splitShown;
  const toggleExpand = useCallback(() => setExpanded((current) => !current), []);

  const boardNode = board ? (
    <TaskBoard
      tasks={tasks}
      finished={finished}
      view={view}
      selectedTaskId={useInlineSplit ? openTask?.id : undefined}
      onOpenTask={openTask && useInlineSplit ? switchPopup : openPopup}
      renderTitle={renderTaskTitle}
      onCommand={command}
      commandsPending={!hydrated}
      project={project !== undefined}
      newTask={newTask}
    />
  ) : null;

  const inlinePopupNode =
    openTask && useInlineSplit ? (
      <Suspense fallback={null}>
        <OverviewTaskPopup
          key={openTask.conversationId}
          task={openTask}
          onOpenTask={openConversationTask}
          onOpenTaskIn={openPopup}
          onClose={closePopup}
          onCommand={(input) => (command ? command(openTask, input) : Promise.resolve())}
          onTaskChanged={refreshOverview}
          inline={{
            mode: isExpanded ? "expanded" : "split",
            expanded: isExpanded,
            onToggleExpand: toggleExpand,
            navigation,
          }}
        />
      </Suspense>
    ) : null;

  if (!board) {
    return openTask ? (
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
    ) : null;
  }

  if (!useInlineSplit) {
    return (
      <div ref={splitRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
        {boardNode}
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
      </div>
    );
  }

  return (
    <div ref={splitRef} className="flex h-full min-h-0 min-w-0 flex-1">
      <Group
        groupRef={groupRef}
        id="task-board-split"
        orientation="horizontal"
        defaultLayout={splitLayout.defaultLayout}
        onLayoutChanged={splitLayout.onLayoutChanged}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <Panel
          id="board"
          minSize={`${BOARD_MIN_REM}rem`}
          hidden={isExpanded}
          className="flex min-h-0 min-w-0 flex-col"
        >
          {boardNode}
        </Panel>
        {openTask && (
          <>
            {!isExpanded && (
              <Separator
                aria-label={m.tasks_panel_resize()}
                onDoubleClick={() =>
                  groupRef.current?.setLayout({
                    board: 100 - TASK_PANE_DEFAULT_PCT,
                    task: TASK_PANE_DEFAULT_PCT,
                  })
                }
                className="group/sep relative flex w-px shrink-0 cursor-col-resize items-center justify-center bg-border-secondary outline-focus-ring transition-colors hover:bg-brand-solid focus-visible:bg-brand-solid focus-visible:outline-2 data-[separator=active]:bg-brand-solid after:absolute after:inset-y-0 after:-inset-x-1.5"
              >
                <span
                  aria-hidden="true"
                  className="pointer-events-none h-7 w-1 rounded-full bg-fg-quaternary/60 opacity-0 transition-opacity group-hover/sep:opacity-100 group-data-[separator=active]/sep:bg-brand-solid group-data-[separator=active]/sep:opacity-100"
                />
              </Separator>
            )}
            <Panel
              id="task"
              defaultSize={`${TASK_PANE_DEFAULT_PCT}`}
              minSize={`${TASK_PANE_MIN_REM}rem`}
              maxSize={isExpanded ? undefined : "65"}
              className="flex min-h-0 min-w-0 flex-col"
            >
              <div
                className={cn(
                  "flex min-h-0 min-w-0 flex-1 flex-col bg-primary",
                  !isExpanded && SIDE_PANE_ENTER,
                )}
              >
                {inlinePopupNode}
              </div>
            </Panel>
          </>
        )}
      </Group>
    </div>
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
      preload={false}
      className={TASK_TITLE_CLASS}
    >
      {title}
    </Link>
  );
}
