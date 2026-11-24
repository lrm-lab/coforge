import { taskNameLabel } from "@lrm/coforge-sdk/internal";
import type { TaskLink, TaskName } from "@lrm/coforge-sdk/internal";
import { useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Tree,
  TreeItem,
  TreeItemContent,
  type Key,
} from "react-aria-components";
import { AlertCircle, ChevronRight } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { NoResultsWireframe, TaskBoardWireframe } from "#src/components/ui/empty-wireframes";
import { Skeleton } from "#src/components/ui/skeleton";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { statusMatches, taskMatches } from "#src/features/tasks/task-filters";
import type { TaskBoardView } from "#src/features/tasks/task-board-search";
import { TaskOwnerAvatar } from "#src/features/tasks/task-owner";
import { SubtaskProgressRing } from "#src/features/tasks/subtask-progress-ring";
import { TaskParentMark, TaskSubtaskMark } from "#src/features/tasks/task-relations";
import { openBlockers } from "#src/features/tasks/task-relation-edits";
import { TaskLocator } from "#src/features/tasks/task-chip";
import { taskMetaLabel } from "#src/features/tasks/task-meta-label";
import { TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { filterTaskForest, parentIds, type FilteredNode } from "./project-task-tree-model";
import { rowLabel } from "./project-task-row-label";
import { projectTaskForest, type ProjectTask, type useProjectTasks } from "./project-tasks";

export function ProjectTaskTreeView({
  query,
  view,
  onOpenTask,
}: {
  query: ReturnType<typeof useProjectTasks>;
  view: Pick<TaskBoardView, "statuses" | "filter"> &
    Partial<Pick<TaskBoardView, "changeStatuses" | "changeFilter">>;
  onOpenTask: (task: ProjectTask) => void;
}) {
  const router = useRouter();
  const { statuses, filter } = view;
  const nodes = useMemo(
    () =>
      filterTaskForest(
        projectTaskForest(query.data?.tasks ?? []),
        (task) => statusMatches(task.status, statuses) && taskMatches(task, filter),
      ),
    [query.data, statuses, filter],
  );
  const filtered =
    statuses.length > 0 ||
    filter.owners.length > 0 ||
    filter.labels.length > 0 ||
    (filter.channels?.length ?? 0) > 0;
  const [folded, setFolded] = useState<ReadonlySet<Key>>(new Set());
  const expandedKeys = useMemo(
    () => new Set(parentIds(nodes).filter((id) => !folded.has(id))),
    [nodes, folded],
  );
  const byId = useMemo(
    () => new Map((query.data?.tasks ?? []).map((t) => [t.id, t])),
    [query.data],
  );

  const clearFilters = () => {
    if (view.changeStatuses && view.changeFilter) {
      view.changeStatuses([]);
      view.changeFilter({ owners: [], projects: [], labels: [], channels: [] });
      return;
    }
    void router.navigate({
      to: ".",
      replace: true,
      resetScroll: false,
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        status: undefined,
        owners: undefined,
        projects: undefined,
        labels: undefined,
        channels: undefined,
      }),
    });
  };

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        picture={<EmptyIcon icon={AlertCircle} />}
        title={m.empty_tasks_load_failed_title()}
        description={m.empty_load_failed_safe()}
        primaryAction={
          <RetryButton isRetrying={query.isRefetching} onPress={() => void query.refetch()} />
        }
      />
    );
  }
  if (query.isPending) return <ProjectTaskTreeSkeleton />;
  if (nodes.length === 0) {
    return filtered ? (
      <EmptyState
        live="polite"
        picture={<NoResultsWireframe />}
        title={m.tasks_overview_filter_empty()}
        description={m.empty_tasks_no_match_description()}
        primaryAction={
          <Button size="sm" color="secondary" onPress={clearFilters}>
            {m.empty_clear_filters()}
          </Button>
        }
      />
    ) : (
      <EmptyState
        picture={<TaskBoardWireframe accent={false} />}
        title={m.project_tasks_empty()}
        description={m.empty_tasks_first_use_description()}
      />
    );
  }
  return (
    <Tree
      aria-label={m.project_task_tree()}
      selectionMode="none"
      expandedKeys={expandedKeys}
      onExpandedChange={(open) =>
        setFolded((previous) => {
          const next = new Set(previous);
          for (const id of parentIds(nodes)) {
            if (open.has(id)) next.delete(id);
            else next.add(id);
          }
          return next;
        })
      }
      onAction={(key) => {
        const task = byId.get(String(key));
        if (task) onOpenTask(task);
      }}
      className="overflow-hidden rounded-xl border border-secondary bg-primary outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {nodes.map((node) => (
        <TaskTreeItem key={node.task.id} node={node} />
      ))}
    </Tree>
  );
}

const MAX_TASK_TREE_LEVEL = 4;

function TaskTreeItem({ node }: { node: FilteredNode<ProjectTask> }) {
  const { task, matched } = node;
  const label = rowLabel(task, matched);
  return (
    <TreeItem
      id={task.id}
      textValue={task.title}
      aria-label={label}
      className={({ isFocusVisible }) =>
        cn(
          "group/row cursor-pointer border-t border-secondary outline-hidden first:border-t-0 hover:bg-primary_hover",
          isFocusVisible && "bg-primary_hover ring-2 ring-focus-ring ring-inset",
        )
      }
    >
      <TreeItemContent>
        {({ hasChildItems, isExpanded, level }) => {
          const visualLevel = Math.min(level, MAX_TASK_TREE_LEVEL);
          return (
            <div
              className="flex min-h-12 min-w-0 items-center gap-2 py-2 pr-4"
              style={{ paddingLeft: `${0.5 + (visualLevel - 1) * 1.5}rem` }}
            >
              {hasChildItems ? (
                <AriaButton
                  slot="chevron"
                  aria-label={m.tasks_subtasks_toggle({ name: `#${task.number}` })}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-quaternary outline-hidden hover:bg-secondary_hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-4 transition-transform duration-(--duration-sm) ease-in-out motion-reduce:transition-none",
                      isExpanded && "rotate-90",
                    )}
                  />
                </AriaButton>
              ) : (
                <span aria-hidden="true" className="size-6 shrink-0" />
              )}
              <TaskStatusIcon status={task.status} />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 text-xs text-tertiary tabular-nums">
                    #{task.number}
                  </span>
                  <span
                    className={cn(
                      "truncate text-sm font-medium",
                      matched ? "text-primary" : "text-tertiary",
                    )}
                  >
                    {task.title}
                  </span>
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-tertiary">
                  {task.source.channelName ? (
                    <ChannelPlace id={task.conversationId} name={task.source.channelName} />
                  ) : (
                    <span className="truncate">{task.source.label}</span>
                  )}
                  {task.parent && (level === 1 || level > MAX_TASK_TREE_LEVEL) && (
                    <TaskParentMark parent={task.parent} />
                  )}
                </span>
              </span>
              {task.blocked && <TreeBlockerMark blockedBy={task.blockedBy} />}
              {task.subtasks && (
                <>
                  <span className="hidden sm:inline-flex">
                    <TaskSubtaskMark subtasks={task.subtasks} />
                  </span>
                  <SubtaskProgressRing {...task.subtasks} className="size-4 sm:hidden" />
                </>
              )}
              <TaskOwnerAvatar owner={task.owner} />
            </div>
          );
        }}
      </TreeItemContent>
      {node.children.map((child) => (
        <TaskTreeItem key={child.task.id} node={child} />
      ))}
    </TreeItem>
  );
}

function TreeBlockerMark({ blockedBy }: { blockedBy: readonly (TaskName | TaskLink)[] }) {
  const open = openBlockers(blockedBy);
  const first = open[0];
  if (!first) return null;
  return (
    <AriaDialogTrigger>
      <AriaButton className="inline-flex shrink-0 cursor-pointer items-center rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums outline-hidden hover:text-secondary focus-visible:ring-2 focus-visible:ring-focus-ring">
        {open.length > 1
          ? m.tasks_blocked_by_count({ count: open.length })
          : m.tasks_blocked_by_mark({
              name: first.hidden ? m.tasks_ref_hidden() : taskMetaLabel(first),
            })}
      </AriaButton>
      <Dropdown.Popover placement="bottom end" className="w-72 max-w-[calc(100vw-2rem)]">
        <AriaDialog aria-label={m.tasks_blocked_by()} className="py-2 outline-hidden">
          <p className="px-3 pb-1 text-xs font-semibold text-tertiary">{m.tasks_blocked_by()}</p>
          <ul>
            {open.map((task, index) => (
              <li
                key={task.hidden ? `hidden-${index}` : taskNameLabel(task)}
                className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm"
              >
                {"status" in task && <TaskStatusIcon status={task.status} className="size-3.5" />}
                {task.hidden ? (
                  <span className="truncate text-tertiary">{m.tasks_ref_hidden()}</span>
                ) : (
                  <>
                    {"title" in task && (
                      <span className="min-w-0 truncate text-primary">{task.title}</span>
                    )}
                    <TaskLocator task={task} />
                  </>
                )}
              </li>
            ))}
          </ul>
        </AriaDialog>
      </Dropdown.Popover>
    </AriaDialogTrigger>
  );
}

export function ProjectTaskTreeSkeleton() {
  return (
    <div
      role="status"
      aria-label={m.project_tasks_loading()}
      className="overflow-hidden rounded-xl border border-secondary bg-primary"
    >
      {[0, 1, 1, 0, 0].map((level, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="flex min-h-12 items-center gap-2 border-t border-secondary py-2 pr-4 first:border-t-0"
          style={{ paddingLeft: `${0.5 + level * 1.5}rem` }}
        >
          <span className="size-6 shrink-0" />
          <Skeleton className="size-4 rounded-full" />
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="ml-auto size-6 rounded-full" />
        </div>
      ))}
    </div>
  );
}
