import {
  TASK_CREATE_STATUSES,
  TASK_WRITE_STATUSES,
  type TaskCreateStatus,
  type TaskStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";

import { memo, useCallback, useMemo, useState, type FocusEvent, type ReactNode } from "react";
import { Plus } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { EmptyState } from "#src/components/ui/empty";
import { NoResultsWireframe, TaskBoardWireframe } from "#src/components/ui/empty-wireframes";
import { ChannelNamesIndexProvider } from "#src/features/conversations/channel-name";
import type { Mentionable } from "#src/features/conversations/mention-text";
import { useLatestCallback } from "#src/hooks/use-latest-callback";
import { useTaskHiddenColumns } from "#src/features/settings/task-hidden-columns";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { useAssignTargets } from "./board-assign-to";
import {
  BoardNewTaskDialog,
  canCreateIn,
  canFileNewTask,
  newTaskChoices,
} from "./board-new-task-dialog";
import { CreateTaskDialog } from "./create-task-dialog";
import type { TaskDraft } from "./task-draft";
import { isFinishedStatus, type FinishedStatus } from "./finished-tasks";
import { TASK_TITLE_CLASS, TaskCard } from "./task-card";
import { TaskDetailMenu, taskMenuButton } from "./task-detail-dialog";
import { statusMatches, taskMatches, type FilterableTask } from "./task-filters";
import { WorkspaceLabelsIndexProvider } from "./task-label-chip";
import type { TaskBoardView } from "./task-board-search";
import type { OverviewTaskCommand } from "./task-overview-collection";
import { TaskToolbar } from "./task-toolbar";
import { TaskWorkflow, type TaskControls } from "./task-workflow";
import { useCanSetAnyTaskStatus } from "./task-board-authority";
import { TaskCardSkeleton } from "./tasks-pending";
import type { FinishedColumn, FinishedTasks } from "./use-finished-tasks";

export type BoardTask = TaskView &
  FilterableTask & {
    source?: { label: string; channelName?: string | null };
  };

export type ConversationBoard = {
  header: ReactNode;
  name?: string;
  members?: readonly Mentionable[];
  loading?: boolean;
  error?: string;
  onCreateTask?: (draft: TaskDraft, idempotencyKey: string) => Promise<TaskView[]>;
  conversationId?: string;
  onOpenCreated: (task: TaskView) => void | Promise<void>;
};

const FINISHED: readonly FinishedStatus[] = ["done", "closed"];

export function orderBoardTasks<T extends Pick<TaskView, "status">>(
  tasks: readonly T[],
  statuses: readonly TaskStatus[],
): T[] {
  const activeStatuses =
    statuses.length > 0
      ? TASK_WRITE_STATUSES.filter((status) => statuses.includes(status))
      : TASK_WRITE_STATUSES;
  return activeStatuses.flatMap((status) => tasks.filter((task) => task.status === status));
}

export function TaskBoard<T extends BoardTask>({
  tasks,
  finished,
  view,
  currentMemberId,
  selectedTaskId,
  onOpenTask,
  renderTitle,
  onCommand,
  commandsPending = false,
  conversation,
  project = false,
  newTask,
}: {
  tasks: readonly T[];
  finished: FinishedTasks<T>;
  view: TaskBoardView;
  currentMemberId?: string | null;
  selectedTaskId?: string;
  onOpenTask: (task: T) => void;
  renderTitle?: (task: T, title: ReactNode) => ReactNode;
  onCommand?: (task: T, command: OverviewTaskCommand) => Promise<void>;
  commandsPending?: boolean;
  conversation?: ConversationBoard;
  project?: boolean;
  newTask?: { projectSlug?: string; onCreated: () => void };
}) {
  const { statuses, filter, layout } = view;
  const openTask = useLatestCallback(onOpenTask);
  const runCommand = useLatestCallback((task: T, command: OverviewTaskCommand) =>
    onCommand ? onCommand(task, command) : Promise.resolve(),
  );
  const memberIdFor = useCallback(
    (task: T) => task.currentMemberId ?? currentMemberId ?? null,
    [currentMemberId],
  );
  const availableStatuses = TASK_WRITE_STATUSES;
  const [hiddenColumns, setColumnHidden] = useTaskHiddenColumns();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState<TaskCreateStatus | null>(null);
  const filtered =
    statuses.length > 0 ||
    filter.owners.length > 0 ||
    filter.projects.length > 0 ||
    filter.labels.length > 0;
  const { done, closed } = finished.columns;
  const unfinished = useMemo(() => tasks.filter((task) => !isFinishedStatus(task.status)), [tasks]);
  const visible = useMemo(
    () =>
      [...unfinished, ...done.rows, ...closed.rows].filter(
        (task) => statusMatches(task.status, statuses) && taskMatches(task, filter),
      ),
    [unfinished, done.rows, closed.rows, statuses, filter],
  );
  const choices = useMemo(() => [...unfinished, ...finished.groups], [unfinished, finished.groups]);
  const finishedShown = FINISHED.filter((value) => statusMatches(value, statuses)).reduce(
    (sum, value) => sum + finished.columns[value].count,
    0,
  );
  const loading = (conversation?.loading && tasks.length === 0) || finished.pending;
  const empty = !loading && visible.length === 0 && finishedShown === 0;
  const paged = useMemo(() => {
    const group = (column: FinishedColumn<T>) => ({
      count: column.count,
      onExpandedChange: column.onExpandedChange,
      footer: <FinishedFooter column={column} list={layout === "list"} />,
    });
    return { done: group(done), closed: group(closed) };
  }, [done, closed, layout]);
  const newTaskChoice = useMemo(
    () => (newTask ? newTaskChoices(tasks, newTask.projectSlug) : undefined),
    [tasks, newTask],
  );
  const newTaskPlaces = useAssignTargets({
    enabled: newTask !== undefined && (newTaskChoice?.places.length ?? 0) === 0,
  });
  const canFile = newTaskChoice
    ? canFileNewTask(newTaskChoice.places, newTaskPlaces.targets)
    : false;
  const onCreateTask = onCommand ? conversation?.onCreateTask : undefined;
  const canSetAnyStatus = useCanSetAnyTaskStatus();
  const clearFilters = () => {
    view.changeFilter({ owners: [], projects: [], labels: [] });
    view.changeStatuses([]);
  };
  return (
    <section
      aria-label={m.tasks_board()}
      data-task-board=""
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-primary",
        !conversation && "h-full max-h-full",
      )}
    >
      {conversation?.header}
      <TaskToolbar
        tasks={choices}
        filter={filter}
        statuses={statuses}
        availableStatuses={availableStatuses}
        layout={layout}
        onFilterChange={view.changeFilter}
        onStatusesChange={view.changeStatuses}
        onLayoutChange={view.changeLayout}
        currentMemberId={currentMemberId}
        project={project}
        action={
          onCreateTask ? (
            <Button
              type="button"
              size="sm"
              color="secondary"
              iconLeading={Plus}
              onPress={() => setCreateOpen(true)}
            >
              {m.task_board_create_new_task()}
            </Button>
          ) : (
            newTaskChoice &&
            (onCommand || commandsPending) && (
              <Button
                type="button"
                size="sm"
                color="secondary"
                iconLeading={Plus}
                isDisabled={!onCommand || !canFile}
                onPress={() => setCreating("todo")}
              >
                {m.task_board_create_new_task()}
              </Button>
            )
          )
        }
      />
      {conversation?.error && (
        <p role="alert" className="mx-page mt-4 text-sm text-error-primary">
          {conversation.error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-page py-4 md:py-6">
        {loading && (
          <div role="status" aria-label={m.tasks_loading()} className="grid gap-3">
            <TaskCardSkeleton list={layout === "list"} />
            <TaskCardSkeleton list={layout === "list"} />
            <TaskCardSkeleton list={layout === "list"} />
          </div>
        )}
        {empty && (
          <EmptyState
            size="page"
            live={filtered ? "polite" : undefined}
            picture={
              filtered ? (
                <NoResultsWireframe />
              ) : (
                <TaskBoardWireframe
                  accent={Boolean(onCreateTask || (newTaskChoice && onCommand && canFile))}
                />
              )
            }
            title={
              filtered
                ? m.tasks_overview_filter_empty()
                : conversation
                  ? m.tasks_empty()
                  : m.tasks_overview_empty()
            }
            description={
              filtered
                ? m.empty_tasks_no_match_description()
                : conversation
                  ? m.empty_tasks_conversation_description()
                  : m.empty_tasks_first_use_description()
            }
            primaryAction={
              filtered ? (
                <Button size="sm" color="secondary" onPress={clearFilters}>
                  {m.empty_clear_filters()}
                </Button>
              ) : onCreateTask ? (
                <Button size="sm" iconLeading={Plus} onPress={() => setCreateOpen(true)}>
                  {m.tasks_create()}
                </Button>
              ) : newTaskChoice && onCommand && canFile ? (
                <Button size="sm" iconLeading={Plus} onPress={() => setCreating("todo")}>
                  {m.task_board_create_new_task()}
                </Button>
              ) : undefined
            }
          />
        )}
        <ChannelNamesIndexProvider>
          <WorkspaceLabelsIndexProvider>
            <TaskWorkflow
              tasks={visible}
              canSetAnyStatus={canSetAnyStatus}
              layout={layout}
              statuses={
                empty || loading
                  ? []
                  : statuses.length > 0
                    ? availableStatuses.filter((status) => statuses.includes(status))
                    : availableStatuses
              }
              paged={paged}
              hidden={hiddenColumns}
              onHiddenChange={setColumnHidden}
              disabled={!onCommand}
              commandsPending={commandsPending}
              showMoveError={!conversation}
              adding={
                newTaskChoice && (onCommand || commandsPending) && canFile
                  ? {
                      statuses: TASK_CREATE_STATUSES,
                      onAdd: (next) => {
                        if (canCreateIn(next)) setCreating(next);
                      },
                    }
                  : undefined
              }
              currentMemberId={memberIdFor}
              onMove={async (task, command) => {
                await onCommand?.(task, command);
              }}
              renderTask={(task, controls) => (
                <BoardTaskCard
                  task={task}
                  controls={controls}
                  currentMemberId={memberIdFor(task)}
                  list={layout === "list"}
                  selected={selectedTaskId === task.id}
                  onOpenTask={openTask}
                  renderTitle={renderTitle}
                  onCommand={onCommand ? runCommand : undefined}
                  inConversation={conversation !== undefined}
                  conversationName={conversation?.name}
                  members={conversation?.members}
                  project={project}
                />
              )}
            />
          </WorkspaceLabelsIndexProvider>
        </ChannelNamesIndexProvider>
      </div>
      {newTask && newTaskChoice && creating !== null && (
        <BoardNewTaskDialog
          open
          status={creating}
          places={newTaskChoice.places}
          boardProject={newTaskChoice.boardProject}
          onOpenChange={(open) => !open && setCreating(null)}
          onCreated={newTask.onCreated}
        />
      )}
      {onCreateTask && createOpen && (
        <CreateTaskDialog
          open
          onOpenChange={setCreateOpen}
          where={conversation?.name ? { label: conversation.name } : undefined}
          members={conversation?.members}
          conversationId={conversation?.conversationId}
          onCreate={async (draft, idempotencyKey, { more }) => {
            const created = await onCreateTask(draft, idempotencyKey);
            if (created.length === 1 && !more) await conversation?.onOpenCreated(created[0]!);
          }}
        />
      )}
    </section>
  );
}

function FinishedFooter<T extends BoardTask>({
  column,
  list,
}: {
  column: FinishedColumn<T>;
  list: boolean;
}) {
  if (column.failed)
    return (
      <div className="flex flex-wrap items-center gap-2 px-2 py-3 text-sm text-tertiary">
        {m.tasks_finished_load_failed()}
        <Button size="sm" color="secondary" onPress={column.retry}>
          {m.tasks_finished_retry()}
        </Button>
      </div>
    );
  if (column.rows.length === 0)
    return column.loading ? (
      <div className={cn("flex flex-col", list ? "divide-y divide-secondary" : "gap-2")}>
        <p role="status" className="sr-only">
          {m.tasks_loading()}
        </p>
        <TaskCardSkeleton list={list} />
        <TaskCardSkeleton list={list} />
      </div>
    ) : null;
  if (!column.hasMore) return null;
  return (
    <div className="px-2 py-2">
      <Button
        size="sm"
        color="secondary"
        className="w-full"
        isLoading={column.loading}
        onPress={column.loadMore}
      >
        {m.tasks_finished_load_more()}
      </Button>
    </div>
  );
}

const BoardTaskCard = memo(BoardTaskCardContent) as typeof BoardTaskCardContent;

function BoardTaskCardContent<T extends BoardTask>({
  task,
  controls,
  currentMemberId,
  list,
  selected,
  onOpenTask,
  renderTitle,
  onCommand: onTaskCommand,
  inConversation,
  conversationName,
  members,
  project,
}: {
  task: T;
  controls: TaskControls;
  currentMemberId: string | null;
  list: boolean;
  selected: boolean;
  onOpenTask: (task: T) => void;
  renderTitle?: (task: T, title: ReactNode) => ReactNode;
  onCommand?: (task: T, command: OverviewTaskCommand) => Promise<void>;
  inConversation: boolean;
  conversationName?: string;
  members?: readonly Mentionable[];
  project: boolean;
}) {
  const onOpenDetails = () => onOpenTask(task);
  const onCommand =
    onTaskCommand && ((command: OverviewTaskCommand) => onTaskCommand(task, command));
  const [reached, setReached] = useState(false);
  const [menu, setMenu] = useState<{ start?: "focus" | "open" }>();
  const reach = () => {
    setReached(true);
    if (onTaskCommand) setMenu((current) => current ?? {});
  };
  const { label: menuLabel, ...menuButton } = taskMenuButton(task);
  return (
    <TaskCard
      task={task}
      list={list}
      selected={selected}
      reached={reached}
      onReach={reach}
      renderTitle={(title) =>
        renderTitle ? (
          renderTitle(task, title)
        ) : (
          <AriaButton onPress={onOpenDetails} className={TASK_TITLE_CLASS}>
            {title}
          </AriaButton>
        )
      }
      source={inConversation ? undefined : task.source?.label}
      channel={inConversation ? undefined : task.source?.channelName}
      project={project ? undefined : task.project}
      controls={controls}
      menu={
        onCommand &&
        (menu ? (
          <TaskDetailMenu
            start={menu.start}
            onStarted={() => setMenu({})}
            task={task}
            moves={controls.moves}
            onOpenDetails={onOpenDetails}
            onCommand={onCommand}
            conversationName={inConversation ? conversationName : task.source?.label}
            members={members}
            currentMemberId={currentMemberId}
          />
        ) : (
          <ButtonUtility
            aria-label={menuLabel}
            aria-haspopup="menu"
            {...menuButton}
            onFocus={(event: FocusEvent<HTMLElement>) =>
              event.currentTarget.matches(":focus-visible") && setMenu({ start: "focus" })
            }
            onClick={() => setMenu({ start: "open" })}
          />
        ))
      }
    />
  );
}
