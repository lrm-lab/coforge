import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { TaskOwnerAvatar } from "#src/features/tasks/task-owner";
import { TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { loadProjectTasks } from "#src/features/tasks/tasks.functions";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

type ProjectTask = Awaited<ReturnType<typeof loadProjectTasks>>["tasks"][number];
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

/**
 * The Project page's Tasks (task #460): its unfinished Tasks, a sub-task under its main Task, each
 * opening in the Tasks page's popup. A private channel's Tasks show only to its members, as the
 * read decides.
 */
export function ProjectTasksSection({ projectId }: { projectId: string }) {
  const load = useServerFn(loadProjectTasks);
  const query = useQuery({
    queryKey: ["project-tasks", projectId],
    queryFn: () => load({ data: { projectId } }),
  });
  const tasks = query.data?.tasks ?? [];
  const forest = projectTaskForest(tasks);
  return (
    <section className="min-w-0 lg:col-span-2">
      <div className="mb-3 flex min-h-9 items-center gap-2">
        <h2 className="text-md font-semibold text-primary">{m.project_tasks()}</h2>
        {tasks.length > 0 && (
          <span className="text-sm text-tertiary tabular-nums">{tasks.length}</span>
        )}
      </div>
      <div className="overflow-hidden rounded-xl border border-secondary">
        {query.isError ? (
          <p className="px-4 py-10 text-center text-sm text-error-primary">
            {m.project_tasks_failed()}
          </p>
        ) : query.isPending ? (
          <p className="px-4 py-10 text-center text-sm text-tertiary">
            {m.project_tasks_loading()}
          </p>
        ) : forest.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-tertiary">{m.project_tasks_empty()}</p>
        ) : (
          <ul className="divide-y divide-secondary">
            {forest.map((node) => (
              <ProjectTaskTree key={node.task.id} node={node} depth={0} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ProjectTaskTree({ node, depth }: { node: ProjectTaskNode; depth: number }) {
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

function ProjectTaskRow({ task, depth }: { task: ProjectTask; depth: number }) {
  const workspaceSlug = useWorkspaceSlug();
  return (
    <Link
      to="/w/$workspaceSlug/tasks"
      params={{ workspaceSlug }}
      search={{ task: `${task.conversationId}:${task.number}` }}
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
