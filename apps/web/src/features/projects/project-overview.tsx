import { useQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { ArrowUpRight } from "@untitledui/icons";

import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { loadFinishedTasks } from "#src/features/tasks/tasks.functions";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import {
  projectTaskForest,
  ProjectTaskRow,
  ProjectTaskTree,
  useProjectTasks,
  type ProjectTask,
  type ProjectTaskNode,
} from "./project-tasks";

/** How many of the Project's latest finished Tasks its overview lists. */
const RECENTLY_DONE = 5;

const ACTIVE = new Set<string>(["in_progress", "in_review"]);

/**
 * What the Project's overview and its phone Tasks list read (task #504): the unfinished Tasks as a
 * forest, the latest few Done, how many are Done in all, and who owns the unfinished ones.
 */
function useProjectOverview(projectId: string) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const open = useProjectTasks(projectId);
  const summary = useQuery(finishedSummaryQuery({ workspaceId }, "all"));
  const recent = useQuery({
    queryKey: ["project-recent-done", projectId],
    queryFn: () =>
      loadFinishedTasks({ data: { status: "done", window: "all", projects: [projectId] } }),
  });
  const tasks = open.data?.tasks ?? [];
  const done = (summary.data?.groups ?? [])
    .filter((group) => group.status === "done" && group.project?.id === projectId)
    .reduce((sum, group) => sum + group.count, 0);
  const people = useMemo(() => {
    const seen = new Map<string, NonNullable<ProjectTask["owner"]>>();
    for (const task of tasks) {
      if (task.owner && !seen.has(task.owner.id)) seen.set(task.owner.id, task.owner);
    }
    return [...seen.values()];
  }, [tasks]);
  const forest = projectTaskForest(tasks);
  return {
    active: forest.filter((node) => ACTIVE.has(node.task.status)),
    next: forest.filter((node) => !ACTIVE.has(node.task.status)),
    recentDone: (recent.data?.tasks ?? []).slice(0, RECENTLY_DONE),
    done,
    total: tasks.length + done,
    people,
    pending: open.isPending,
    failed: open.isError,
  };
}

type Overview = ReturnType<typeof useProjectOverview>;

/** The Project page's Overview tab: what it is for, how far it got, who is on it, its Tasks. */
export function ProjectOverview({
  project,
}: {
  project: { id: string; description: string | null; githubFullName: string | null };
}) {
  const data = useProjectOverview(project.id);
  return (
    <div className="mx-auto w-full max-w-3xl px-page py-6 sm:py-8">
      <p
        className={cx(
          "text-md whitespace-pre-wrap break-words",
          project.description ? "text-secondary" : "text-quaternary",
        )}
      >
        {project.description || m.project_no_description()}
      </p>
      <dl className="mt-6 grid grid-cols-[6.5rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
        <dt className="text-tertiary">{m.project_progress()}</dt>
        <dd>
          <Progress done={data.done} total={data.total} />
        </dd>
        <dt className="text-tertiary">{m.project_people()}</dt>
        <dd className="min-w-0">
          <People people={data.people} />
        </dd>
        {project.githubFullName && (
          <>
            <dt className="text-tertiary">{m.project_repository()}</dt>
            <dd className="min-w-0">
              <a
                href={`https://github.com/${project.githubFullName}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex max-w-full items-center gap-1 text-sm text-secondary hover:text-primary"
              >
                <span className="truncate">{project.githubFullName}</span>
                <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0" />
              </a>
            </dd>
          </>
        )}
      </dl>
      <ProjectTaskGroupsOf data={data} />
    </div>
  );
}

/** The Project's Tasks as the three groups, for the Tasks tab on a phone, where a board is cramped. */
export function ProjectTaskGroups({ projectId }: { projectId: string }) {
  const data = useProjectOverview(projectId);
  return (
    <div className="px-page pb-6">
      <ProjectTaskGroupsOf data={data} />
    </div>
  );
}

function ProjectTaskGroupsOf({ data }: { data: Overview }) {
  if (data.failed) {
    return <p className="mt-8 text-sm text-error-primary">{m.project_tasks_failed()}</p>;
  }
  if (data.pending) {
    return <p className="mt-8 text-sm text-tertiary">{m.project_tasks_loading()}</p>;
  }
  if (data.active.length + data.next.length + data.recentDone.length === 0) {
    return <p className="mt-8 text-sm text-tertiary">{m.project_tasks_empty()}</p>;
  }
  const tree = (nodes: ProjectTaskNode[]) => (
    <ul className="divide-y divide-secondary">
      {nodes.map((node) => (
        <ProjectTaskTree key={node.task.id} node={node} depth={0} />
      ))}
    </ul>
  );
  return (
    <>
      <Group title={m.project_in_progress()} count={data.active.length}>
        {tree(data.active)}
      </Group>
      <Group title={m.project_up_next()} count={data.next.length}>
        {tree(data.next)}
      </Group>
      <Group title={m.project_recently_done()} count={data.recentDone.length}>
        <ul className="divide-y divide-secondary">
          {data.recentDone.map((task) => (
            <li key={task.id}>
              <ProjectTaskRow task={{ ...task, parentTaskId: null }} depth={0} />
            </li>
          ))}
        </ul>
      </Group>
    </>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-primary">
        {title}
        <span className="font-normal text-tertiary tabular-nums">{count}</span>
      </h2>
      <div className="overflow-hidden rounded-xl border border-secondary">{children}</div>
    </section>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : done / total;
  return (
    <span className="flex items-center gap-2.5">
      <span className="h-1.5 w-40 overflow-hidden rounded-full bg-quaternary">
        <span
          className="block h-full rounded-full bg-fg-success-secondary"
          style={{ width: `${share * 100}%` }}
        />
      </span>
      <span className="text-sm text-secondary tabular-nums">
        {done} / {total}
      </span>
    </span>
  );
}

function People({ people }: { people: Overview["people"] }) {
  if (people.length === 0) return <span className="text-sm text-quaternary">—</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="flex -space-x-1.5">
        {people.slice(0, 5).map((person) => (
          <ActorAvatar
            key={person.id}
            presence={false}
            size="xs"
            name={person.name}
            alt={person.name}
            src={person.avatarUrl ?? undefined}
            agentId={person.kind === "agent" ? person.id : undefined}
            className="ring-2 ring-bg-primary"
          />
        ))}
      </span>
      <span className="truncate text-sm text-secondary">
        {people
          .slice(0, 3)
          .map((person) => person.name)
          .join(", ")}
        {people.length > 3 && ` +${people.length - 3}`}
      </span>
    </span>
  );
}
