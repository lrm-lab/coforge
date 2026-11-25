import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useMemo, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useOpenConversationTask } from "#src/features/conversations/open-conversation-thread";
import { m } from "#src/paraglide/messages";
import { isFinishedStatus } from "./finished-tasks";
import { TaskBoard, orderBoardTasks, type ConversationBoard } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import { useRegisterTaskNavigation, type TaskDetailNavigation } from "./task-detail-panel";
import { statusMatches, taskMatches } from "./task-filters";
import type { OverviewTaskCommand } from "./task-overview-collection";
import { useFinishedTasks } from "./use-finished-tasks";
import { useUnfinishedTasks, type ConversationTaskCommands } from "./use-conversation-tasks";

export function filterConversationBoardTasks<
  T extends Pick<TaskView, "number" | "parent" | "project">,
>(tasks: readonly T[], projects: readonly string[]): T[] {
  const byNumber = new Map(tasks.map((task) => [task.number, task]));
  return tasks.filter((task) => {
    if (!task.parent || task.parent.hidden || task.parent.channel !== null) return true;
    const parent = byNumber.get(task.parent.number);
    if (!parent) return true;
    return !(projects.length === 0 || projects.includes(parent.project?.id ?? "none"));
  });
}

function useHeldTasks(conversationId: string, listed: readonly TaskView[]) {
  const [shown, setShown] = useState(() => ({ conversationId, ids: new Set<string>() }));
  const known = shown.conversationId === conversationId ? shown.ids : undefined;
  const unseen = listed.filter((task) => !isFinishedStatus(task.status) && !known?.has(task.id));
  let ids = known ?? new Set<string>();
  if (!known || unseen.length > 0) {
    ids = new Set([...ids, ...unseen.map((task) => task.id)]);
    setShown({ conversationId, ids });
  }
  return useMemo(
    () => listed.filter((task) => !isFinishedStatus(task.status) || ids.has(task.id)),
    [listed, ids],
  );
}

export function ConversationTaskBoard({
  conversationId,
  currentMemberId,
  canMutate,
  taskView,
  search,
  onOpenTask,
  onOpenMessage,
  ...conversation
}: Omit<ConversationBoard, "loading" | "error" | "onOpenCreated"> & {
  conversationId: string;
  currentMemberId: string;
  canMutate: boolean;
  taskView: ConversationTaskCommands;
  search: Parameters<typeof useTaskBoardSearch>[0];
  onOpenTask: (number: number) => void;
  onOpenMessage: (messageId: string) => void | Promise<void>;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const view = useTaskBoardSearch(search);
  const { openTaskNumber } = useOpenConversationTask();
  const { command } = taskView;
  const { tasks: listed, loading, failed } = useUnfinishedTasks(conversationId);
  const error = taskView.error || (failed ? m.tasks_load_error() : "");
  const held = useHeldTasks(conversationId, listed);
  const tasks = useMemo(
    () => filterConversationBoardTasks(held, view.filter.projects),
    [held, view.filter.projects],
  );
  const finished = useFinishedTasks({
    scope: { workspaceId, conversationId },
    window: view.completedWindow,
    filter: view.filter,
    onPage: tasks,
  });
  const orderedTasks = useMemo(() => {
    const unfinished = tasks.filter((task) => !isFinishedStatus(task.status));
    const visible = [
      ...unfinished,
      ...finished.columns.done.rows,
      ...finished.columns.closed.rows,
    ].filter((task) => statusMatches(task.status, view.statuses) && taskMatches(task, view.filter));
    return orderBoardTasks(visible, view.statuses);
  }, [tasks, finished.columns.done.rows, finished.columns.closed.rows, view.statuses, view.filter]);

  const selectedTaskId = useMemo(
    () =>
      openTaskNumber !== undefined
        ? orderedTasks.find((task) => task.number === openTaskNumber)?.id
        : undefined,
    [openTaskNumber, orderedTasks],
  );

  const navigation = useMemo<TaskDetailNavigation | undefined>(() => {
    if (openTaskNumber === undefined || orderedTasks.length === 0) return undefined;
    const index = orderedTasks.findIndex((task) => task.number === openTaskNumber);
    if (index < 0) return undefined;
    const prev = orderedTasks[index - 1];
    const next = orderedTasks[index + 1];
    return {
      hasPrev: Boolean(prev),
      hasNext: Boolean(next),
      onPrev: () => {
        if (prev) onOpenTask(prev.number);
      },
      onNext: () => {
        if (next) onOpenTask(next.number);
      },
    };
  }, [openTaskNumber, orderedTasks, onOpenTask]);

  useRegisterTaskNavigation(navigation);

  const run = useMemo(
    () =>
      canMutate
        ? (_task: TaskView, input: OverviewTaskCommand) => command(input).then(() => {})
        : undefined,
    [canMutate, command],
  );
  return (
    <TaskBoard
      tasks={tasks}
      finished={finished}
      view={view}
      currentMemberId={currentMemberId || null}
      selectedTaskId={selectedTaskId}
      onOpenTask={(task) => onOpenTask(task.number)}
      onCommand={run}
      conversation={{
        ...conversation,
        conversationId,
        loading,
        error,
        onOpenCreated: (task) =>
          task.messageId ? onOpenMessage(task.messageId) : onOpenTask(task.number),
      }}
    />
  );
}
