import { taskNameLabel } from "@lrm/coforge-sdk/internal";
import type { TaskLink, TaskName } from "@lrm/coforge-sdk/internal";
import { useMemo, useState } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Tree,
  TreeItem,
  TreeItemContent,
  type Key,
} from "react-aria-components";
import { ChevronRight } from "@untitledui/icons";

import { Dropdown } from "#src/components/base/dropdown/dropdown";
import { Skeleton } from "#src/components/ui/skeleton";

import { statusMatches, taskMatches } from "#src/features/tasks/task-filters";
import type { TaskBoardView } from "#src/features/tasks/task-board-search";
import { TaskOwnerAvatar } from "#src/features/tasks/task-owner";
import { SubtaskProgressRing } from "#src/features/tasks/subtask-progress-ring";
import { TaskParentMark, TaskSubtaskMark } from "#src/features/tasks/task-relations";
import { openBlockers } from "#src/features/tasks/task-relation-edits";
import { TaskLocator, taskMetaLabel } from "#src/features/tasks/task-chip";
import { TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { statusLabel } from "#src/features/tasks/task-workflow";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { filterTaskForest, parentIds, type FilteredNode } from "./project-task-tree-model";
import { projectTaskForest, type ProjectTask, type useProjectTasks } from "./project-tasks";

/**
 * A Project's Tasks as a tree (task #462), the list layout of its Tasks tab, as Linear's list shows
 * sub-issues nested under their parents: every unfinished Task the viewer can read, each under its
 * parent. A row reads its status, number and title, what it still waits on, how far its sub-tasks
 * are and its owner, with its channel under the title; a sub-task whose parent is not in the tree
 * (finished, in another Project or not the viewer's) sits at the top, naming that parent. A filter
 * keeps a passing Task's ancestors, greyed and read as outside the filter, still opening. Arrow
 * keys move and fold (React Aria's treegrid), Enter or a click opens the Task's popup; live like
 * the Overview.
 */
export function ProjectTaskTreeView({
  query,
  view,
  onOpenTask,
}: {
  /** The Project's Tasks (`useProjectTasks`), read by the board, whose picks offer them too. */
  query: ReturnType<typeof useProjectTasks>;
  view: Pick<TaskBoardView, "statuses" | "filter">;
  onOpenTask: (task: ProjectTask) => void;
}) {
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
  // Folding is the page's own: every parent opens unfolded, and one that appears later does too.
  const [folded, setFolded] = useState<ReadonlySet<Key>>(new Set());
  const expandedKeys = useMemo(
    () => new Set(parentIds(nodes).filter((id) => !folded.has(id))),
    [nodes, folded],
  );
  const byId = useMemo(
    () => new Map((query.data?.tasks ?? []).map((t) => [t.id, t])),
    [query.data],
  );

  if (query.isError)
    return <p className="text-sm text-error-primary">{m.project_tasks_failed()}</p>;
  if (query.isPending) return <ProjectTaskTreeSkeleton />;
  if (nodes.length === 0)
    return (
      <p className="py-16 text-center text-sm text-tertiary">
        {filtered ? m.tasks_overview_filter_empty() : m.project_tasks_empty()}
      </p>
    );
  return (
    <Tree
      aria-label={m.project_task_tree()}
      selectionMode="none"
      expandedKeys={expandedKeys}
      // Only the parents shown change: one a filter hides keeps its fold for when it is back.
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

/** A Task it waits on, as the reader may name it. */
function blockerName(task: TaskName | TaskLink) {
  if (task.hidden) return m.tasks_ref_hidden();
  return "title" in task ? `${task.title} ${taskMetaLabel(task)}` : taskMetaLabel(task);
}

/** How many blockers a row's label names; the press-opened list has them all. */
const NAMED_BLOCKERS = 3;

/**
 * What a screen reader says for a row: its name, its status, the first Tasks it waits on by name
 * (then how many more), how far its sub-tasks are, and whether the filter passes it. Its level comes from the tree itself
 * (`aria-level`). The names are in the label, not a description: React Aria's `TreeItem` takes no
 * `aria-describedby`.
 */
function rowLabel(task: ProjectTask, matched: boolean) {
  const open = openBlockers(task.blockedBy);
  return [
    `#${task.number} ${task.title}`,
    statusLabel(task.status),
    open.length > 0 &&
      `${m.tasks_blocked_by()} ${[
        ...open.slice(0, NAMED_BLOCKERS).map(blockerName),
        open.length > NAMED_BLOCKERS &&
          m.project_task_tree_more_blockers({ count: open.length - NAMED_BLOCKERS }),
      ]
        .filter(Boolean)
        .join(", ")}`,
    task.subtasks && m.tasks_subtasks_finished(task.subtasks),
    !matched && m.project_task_tree_outside(),
  ]
    .filter(Boolean)
    .join(", ");
}

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
        {({ hasChildItems, isExpanded, level }) => (
          <div
            className="flex min-h-12 min-w-0 items-center gap-2 py-2 pr-4"
            // One step in per level; the chevron's room is kept on a leaf so titles line up.
            style={{ paddingLeft: `${0.5 + (level - 1) * 1.5}rem` }}
          >
            {hasChildItems ? (
              <AriaButton
                slot="chevron"
                aria-label={m.tasks_subtasks_toggle({ name: `#${task.number}` })}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-quaternary outline-hidden hover:bg-secondary_hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn("size-4 transition-transform", isExpanded && "rotate-90")}
                />
              </AriaButton>
            ) : (
              <span aria-hidden="true" className="size-6 shrink-0" />
            )}
            <TaskStatusIcon status={task.status} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-xs text-tertiary tabular-nums">#{task.number}</span>
                <span
                  // An ancestor kept only for what passes below it reads quieter, in a token that
                  // keeps the text's contrast.
                  className={cn(
                    "truncate text-sm font-medium",
                    matched ? "text-primary" : "text-tertiary",
                  )}
                >
                  {task.title}
                </span>
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-tertiary">
                <span className="truncate">{task.source.label}</span>
                {/* Its parent is not in the tree: named, since nothing above it shows. */}
                {task.parent && level === 1 && <TaskParentMark parent={task.parent} />}
              </span>
            </span>
            {task.blocked && <TreeBlockerMark blockedBy={task.blockedBy} />}
            {task.subtasks && (
              <>
                <span className="hidden sm:inline-flex">
                  <TaskSubtaskMark subtasks={task.subtasks} />
                </span>
                {/* A phone has room for the ring alone; the row's label says the count. */}
                <SubtaskProgressRing {...task.subtasks} className="size-4 sm:hidden" />
              </>
            )}
            <TaskOwnerAvatar owner={task.owner} />
          </div>
        )}
      </TreeItemContent>
      {node.children.map((child) => (
        <TaskTreeItem key={child.task.id} node={child} />
      ))}
    </TreeItem>
  );
}

/**
 * "Waiting on #388" or "Waiting on 3 tasks", as a card says it, which opens the list of them on a
 * press: a hover tooltip never shows on a phone, and a row's own press opens the Task.
 */
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

/** The tree's shape before its Tasks arrive, or before the page knows it is the list. */
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
