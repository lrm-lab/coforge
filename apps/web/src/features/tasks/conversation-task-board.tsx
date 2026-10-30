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

/**
 * The Tasks a conversation's board holds itself: every unfinished one, and a finished one only
 * once the board showed it unfinished (moved to Done or Closed since), so it stays in place. The
 * rest of Done and Closed are read in pages, as the Tasks page reads them.
 *
 * The ids it has shown are kept in state per conversation and grown during render when a new
 * unfinished Task appears (React's "storing information from previous renders"), so a Task moved
 * to Done never drops out for a frame.
 */
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

/**
 * A conversation's Tasks tab: the Task board scoped to one conversation. It reads the unfinished
 * Tasks itself while it shows (`useUnfinishedTasks`); Done and Closed are counted and paged by the
 * server within the finished-work window, as on the Tasks page.
 */
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
  /** The viewer's membership in the conversation; empty when they are not a member. */
  currentMemberId: string;
  canMutate: boolean;
  taskView: ConversationTaskCommands;
  search: Parameters<typeof useTaskBoardSearch>[0];
  onOpenTask: (number: number) => void;
  /** Where a Task made from a message is shown: that message in the chat. */
  onOpenMessage: (messageId: string) => void | Promise<void>;
}) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const view = useTaskBoardSearch(search);
  const { command } = taskView;
  const { tasks: listed, loading, failed } = useUnfinishedTasks(conversationId);
  const error = taskView.error || (failed ? m.tasks_load_error() : "");
  const held = useHeldTasks(conversationId, listed);
  const tasks = useMemo(
    () => held.map((task) => ({ ...task, currentMemberId: currentMemberId || null })),
    [held, currentMemberId],
  );
  const finished = useFinishedTasks({
    scope: { workspaceId, conversationId },
    window: view.completedWindow,
    filter: view.filter,
    onPage: tasks,
  });
  // The command writes its result into the conversation's Tasks, which reads Done and Closed again
  // when they changed; its announcement then finds nothing new.
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
        loading,
        error,
        // A Task made from a message opens on it in the chat; one without a message, its popup.
        onOpenCreated: (task) =>
          task.messageId ? onOpenMessage(task.messageId) : onOpenTask(task.number),
      }}
    />
  );
}
