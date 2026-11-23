import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { decodeTaskChangedEvent } from "#src/features/tasks/task-realtime";
import { TaskOwnerAvatar } from "#src/features/tasks/task-owner";
import { TaskParentMark } from "#src/features/tasks/task-relations";
import { TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { loadProjectTasks } from "#src/features/tasks/tasks.functions";
import { overviewTaskParam } from "#src/features/tasks/task-overview-search";
import { cn } from "#src/lib/utils";
import { taskForest } from "./project-task-tree-model";

export type ProjectTask = Awaited<ReturnType<typeof loadProjectTasks>>["tasks"][number];
export type ProjectTaskNode = { task: ProjectTask; children: ProjectTaskNode[] };

export function projectTaskForest(tasks: readonly ProjectTask[]): ProjectTaskNode[] {
  return taskForest(tasks);
}

const appRoute = getRouteApi("/w/$workspaceSlug");

export function useProjectTasks(projectId: string | undefined) {
  const load = useServerFn(loadProjectTasks);
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const query = useQuery({
    queryKey: ["project-tasks", projectId],
    queryFn: () => load({ data: { projectId: projectId! } }),
    enabled: projectId !== undefined,
  });
  const onTaskChanged = useCallback(
    (publication: { data: unknown }) => {
      if (decodeTaskChangedEvent(publication.data)) {
        void queryClient.invalidateQueries({ queryKey: ["project-tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["project-recent-done"] });
      }
    },
    [queryClient],
  );
  useRealtimeSubscription({
    channel: projectId && workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: onTaskChanged,
  });
  useRealtimeSubscription({
    channel: projectId ? userConversationChannel(userId) : undefined,
    onPublication: onTaskChanged,
  });
  return query;
}

export function ProjectTaskTree({ node, depth }: { node: ProjectTaskNode; depth: number }) {
  return (
    <li>
      <ProjectTaskRow task={node.task} depth={depth} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <ProjectTaskTree key={child.task.id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

const MAX_TASK_INDENT_DEPTH = 3;

export function ProjectTaskRow({ task, depth }: { task: ProjectTask; depth: number }) {
  const visualDepth = Math.min(depth, MAX_TASK_INDENT_DEPTH);
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-center gap-3 py-3 pr-4 hover:bg-primary_hover",
        depth > 0 && "border-t border-secondary",
      )}
      style={{ paddingLeft: `${1 + visualDepth * 1.5}rem` }}
    >
      {depth > 0 && (
        <span
          aria-hidden="true"
          className="-ml-3 h-4 w-3 shrink-0 rounded-bl border-b border-l border-primary"
        />
      )}
      <TaskStatusIcon status={task.status} />
      <span className="min-w-0 flex-1">
        <Link
          to="."
          search={(previous: Record<string, unknown>) => ({
            ...previous,
            task: overviewTaskParam(task),
          })}
          resetScroll={false}
          className="block truncate rounded-xs text-sm font-medium text-primary outline-focus-ring after:absolute after:inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {task.title}
        </Link>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-tertiary">
          {task.source.channelName ? (
            <ChannelPlace id={task.conversationId} name={task.source.channelName} />
          ) : (
            <span className="truncate">{task.source.label}</span>
          )}
          <span className="shrink-0 tabular-nums">#{task.number}</span>
          {depth > MAX_TASK_INDENT_DEPTH && task.parent && (
            <span className="relative z-10">
              <TaskParentMark parent={task.parent} />
            </span>
          )}
        </span>
      </span>
      <TaskOwnerAvatar owner={task.owner} />
    </div>
  );
}
