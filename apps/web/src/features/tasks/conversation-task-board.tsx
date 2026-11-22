import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useMemo, useState } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { isFinishedStatus } from "./finished-tasks";
import { TaskBoard, type ConversationBoard } from "./task-board";
import { useTaskBoardSearch } from "./task-board-search";
import type { OverviewTaskCommand } from "./task-overview-collection";
import { useFinishedTasks } from "./use-finished-tasks";
import { useUnfinishedTasks, type ConversationTaskCommands } from "./use-conversation-tasks";
import { m } from "#src/paraglide/messages";

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
  const { command } = taskView;
  const { tasks: listed, loading, failed } = useUnfinishedTasks(conversationId);
  const error = taskView.error || (failed ? m.tasks_load_error() : "");
  const held = useHeldTasks(conversationId, listed);
  const tasks = useMemo(
    () =>
      filterConversationBoardTasks(held, view.filter.projects).map((task) => ({
        ...task,
        currentMemberId: currentMemberId || null,
      })),
    [held, view.filter.projects, currentMemberId],
  );
  const finished = useFinishedTasks({
    scope: { workspaceId, conversationId },
    window: view.completedWindow,
    filter: view.filter,
    onPage: tasks,
  });
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
