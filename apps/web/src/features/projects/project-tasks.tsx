import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { useRealtimeSubscription } from "#src/features/realtime/browser-realtime";
import {
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { decodeTaskChangedEvent } from "#src/features/tasks/task-realtime";
import { TaskOwnerAvatar } from "#src/features/tasks/task-owner";
import { TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { loadProjectTasks } from "#src/features/tasks/tasks.functions";
import { overviewTaskParam } from "#src/features/tasks/task-overview-search";
import { cn } from "#src/lib/utils";

export type ProjectTask = Awaited<ReturnType<typeof loadProjectTasks>>["tasks"][number];
export type ProjectTaskNode = { task: ProjectTask; children: ProjectTaskNode[] };

/**
 * The Project's unfinished Tasks as a forest: each Task under its parent when the parent is listed
 * too, otherwise at the top (its parent is finished, elsewhere or not visible). Order is the
 * list's own (by conversation, then number).
 */
export function projectTaskForest(tasks: readonly ProjectTask[]): ProjectTaskNode[] {
  const nodes = new Map(tasks.map((task) => [task.id, { task, children: [] } as ProjectTaskNode]));
  const roots: ProjectTaskNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.task.parentTaskId ? nodes.get(node.task.parentTaskId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

const appRoute = getRouteApi("/w/$workspaceSlug");

/**
 * The Project's unfinished Tasks (task #460), live: a Task's Project change arrives as
 * `task.changed.v1` (task #484), and the prefix invalidates every Project's read whichever Project
 * it moved from or to. A private channel's Tasks show only to its members, as the read decides.
 */
export function useProjectTasks(projectId: string) {
  const load = useServerFn(loadProjectTasks);
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const userId = appRoute.useLoaderData({ select: (data) => data.user.id });
  const query = useQuery({
    queryKey: ["project-tasks", projectId],
    queryFn: () => load({ data: { projectId } }),
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
    channel: workspaceId ? workspaceConversationChannel(workspaceId) : undefined,
    onPublication: onTaskChanged,
  });
  useRealtimeSubscription({
    channel: userConversationChannel(userId),
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

/** A Task's row; it opens the Task's popup over the Project page. */
export function ProjectTaskRow({ task, depth }: { task: ProjectTask; depth: number }) {
  return (
    <Link
      to="."
      search={(previous: Record<string, unknown>) => ({
        ...previous,
        task: overviewTaskParam(task),
      })}
      resetScroll={false}
      className={cn(
        "flex min-w-0 items-center gap-3 py-3 pr-4 outline-focus-ring hover:bg-primary_hover focus-visible:outline-2 focus-visible:-outline-offset-2",
        depth > 0 && "border-t border-secondary",
      )}
      // A sub-task sits under its main Task, one step in per level.
      style={{ paddingLeft: `${1 + depth * 1.5}rem` }}
    >
      {depth > 0 && (
        <span
          aria-hidden="true"
          className="-ml-3 h-4 w-3 shrink-0 rounded-bl border-b border-l border-primary"
        />
      )}
      <TaskStatusIcon status={task.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-primary">{task.title}</span>
        <span className="mt-0.5 block truncate text-xs text-tertiary">
          {task.source.label} · #{task.number}
        </span>
      </span>
      <TaskOwnerAvatar owner={task.owner} />
    </Link>
  );
}
