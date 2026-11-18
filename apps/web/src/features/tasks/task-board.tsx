import {
  TASK_READ_STATUSES,
  TASK_WRITE_STATUSES,
  type TaskWriteStatus,
  type TaskView,
} from "@lrm/coforge-sdk/internal";

import { useMemo, useState, type FocusEvent, type ReactNode } from "react";
import { Plus } from "@untitledui/icons";
import { Button as AriaButton } from "react-aria-components";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import type { Mentionable } from "#src/features/conversations/mention-text";
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

export function TaskBoard<T extends BoardTask>({
  tasks,
  finished,
  view,
  onOpenTask,
  renderTitle,
  onCommand,
  commandsPending = false,
  conversation,
  project = false,
  tree,
  newTask,
}: {
  tasks: readonly T[];
  finished: FinishedTasks<T>;
  view: TaskBoardView;
  onOpenTask: (task: T) => void;
  renderTitle?: (task: T, title: ReactNode) => ReactNode;
  onCommand?: (task: T, command: OverviewTaskCommand) => Promise<void>;
  commandsPending?: boolean;
  conversation?: ConversationBoard;
  project?: boolean;
  tree?: { node: ReactNode; tasks: readonly FilterableTask[] };
  newTask?: { projectSlug?: string; onCreated: () => void };
}) {
  const { statuses, filter, layout } = view;
  const availableStatuses = tasks.some((task) => task.status === "backlog")
    ? TASK_READ_STATUSES
    : TASK_WRITE_STATUSES;
  const showTree = tree !== undefined;
  const [hiddenColumns, setColumnHidden] = useTaskHiddenColumns();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState<TaskWriteStatus | null>(null);
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
  const newTaskPlaces = useAssignTargets({ enabled: newTask !== undefined });
  const canFile = newTaskChoice
    ? canFileNewTask(newTaskChoice.places, newTaskPlaces.targets)
    : false;
  const onCreateTask = onCommand ? conversation?.onCreateTask : undefined;
  const canSetAnyStatus = useCanSetAnyTaskStatus();
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
        tasks={tree ? tree.tasks : choices}
        filter={filter}
        statuses={statuses}
        availableStatuses={availableStatuses}
        layout={layout}
        onFilterChange={view.changeFilter}
        onStatusesChange={view.changeStatuses}
        onLayoutChange={view.changeLayout}
        project={project}
        tree={showTree}
        action={
          onCreateTask ? (
            <Button type="button" size="sm" color="secondary" onPress={() => setCreateOpen(true)}>
              {m.tasks_create()}
            </Button>
          ) : (
            newTaskChoice &&
            (onCommand || commandsPending) && (
              <Button
                type="button"
                size="sm"
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
        <p role="alert" className="mx-4 mt-4 text-sm text-error-primary md:mx-6">
          {conversation.error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
        {tree?.node}
        {!showTree && loading && (
          <p role="status" className="text-sm text-tertiary">
            {m.tasks_loading()}
          </p>
        )}
        {!showTree && empty && (
          <div className="py-16 text-center text-sm">
            <p className="text-tertiary">
              {filtered
                ? m.tasks_overview_filter_empty()
                : conversation
                  ? m.tasks_empty()
                  : m.tasks_overview_empty()}
            </p>
          </div>
        )}
        {!showTree && (
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
                ? { statuses: TASK_WRITE_STATUSES.filter(canCreateIn), onAdd: setCreating }
                : undefined
            }
            currentMemberId={(task) => task.currentMemberId ?? null}
            onMove={async (task, command) => {
              await onCommand?.(task, command);
            }}
            renderTask={(task, controls) => (
              <BoardTaskCard
                task={task}
                controls={controls}
                list={layout === "list"}
                onOpenDetails={() => onOpenTask(task)}
                renderTitle={renderTitle}
                onCommand={onCommand ? (command) => onCommand(task, command) : undefined}
                conversation={conversation}
                project={project}
              />
            )}
          />
        )}
      </div>
      {newTask && newTaskChoice && (
        <BoardNewTaskDialog
          open={creating !== null}
          status={creating ?? "todo"}
          places={newTaskChoice.places}
          boardProject={newTaskChoice.boardProject}
          onOpenChange={(open) => !open && setCreating(null)}
          onCreated={newTask.onCreated}
        />
      )}
      {onCreateTask && (
        <CreateTaskDialog
          open={createOpen}
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
        <Button size="xs" color="secondary" onPress={column.retry}>
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

function BoardTaskCard<T extends BoardTask>({
  task,
  controls,
  list,
  onOpenDetails,
  renderTitle,
  onCommand,
  conversation,
  project,
}: {
  task: T;
  controls: TaskControls;
  list: boolean;
  onOpenDetails: () => void;
  renderTitle?: (task: T, title: ReactNode) => ReactNode;
  onCommand?: (command: OverviewTaskCommand) => Promise<void>;
  conversation?: ConversationBoard;
  project: boolean;
}) {
  const [menu, setMenu] = useState<{ start?: "focus" | "open" }>();
  const reach = () => setMenu((current) => current ?? {});
  const { label: menuLabel, ...menuButton } = taskMenuButton(task);
  return (
    <TaskCard
      task={task}
      list={list}
      onReach={onCommand && reach}
      renderTitle={(title) =>
        renderTitle ? (
          renderTitle(task, title)
        ) : (
          <AriaButton onPress={onOpenDetails} className={TASK_TITLE_CLASS}>
            {title}
          </AriaButton>
        )
      }
      source={conversation ? undefined : task.source?.label}
      channel={conversation ? undefined : task.source?.channelName}
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
            conversationName={conversation ? conversation.name : task.source?.label}
            members={conversation?.members}
            currentMemberId={task.currentMemberId ?? null}
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
