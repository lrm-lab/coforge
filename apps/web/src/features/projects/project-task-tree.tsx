import { useMemo, useState } from "react";
import {
  Button as AriaButton,
  Tree,
  TreeItem,
  TreeItemContent,
  type Key,
} from "react-aria-components";
import { ChevronRight } from "@untitledui/icons";

import { statusMatches, taskMatches } from "#src/features/tasks/task-filters";
import type { TaskBoardView } from "#src/features/tasks/task-board-search";
import { TaskOwnerAvatar } from "#src/features/tasks/task-owner";
import {
  TaskBlockedMark,
  TaskParentMark,
  TaskSubtaskMark,
} from "#src/features/tasks/task-relations";
import { openBlockers } from "#src/features/tasks/task-relation-edits";
import { taskMetaLabel } from "#src/features/tasks/task-chip";
import { TaskStatusIcon } from "#src/features/tasks/task-status-icon";
import { statusLabel } from "#src/features/tasks/task-workflow";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { filterTaskForest, parentIds, type FilteredNode } from "./project-task-tree-model";
import { projectTaskForest, useProjectTasks, type ProjectTask } from "./project-tasks";

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
  projectId,
  view,
  onOpenTask,
}: {
  projectId: string;
  view: Pick<TaskBoardView, "statuses" | "filter">;
  onOpenTask: (task: ProjectTask) => void;
}) {
  const query = useProjectTasks(projectId);
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
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-tertiary">
        {m.project_tasks_loading()}
      </p>
    );
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
      onExpandedChange={(open) =>
        setFolded(new Set(parentIds(nodes).filter((id) => !open.has(id))))
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

/** What a screen reader says for a row: its name, its status, what it waits on, and whether the
 * filter passes it. Its level comes from the tree itself (`aria-level`). */
function rowLabel(task: ProjectTask, matched: boolean) {
  const open = openBlockers(task.blockedBy);
  const first = open[0];
  const waiting = !first
    ? undefined
    : open.length > 1
      ? m.tasks_blocked_by_count({ count: open.length })
      : m.tasks_blocked_by_mark({
          name: first.hidden ? m.tasks_ref_hidden() : taskMetaLabel(first),
        });
  return [
    `#${task.number} ${task.title}`,
    statusLabel(task.status),
    waiting,
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
            className={cn(
              "flex min-h-12 min-w-0 items-center gap-2 py-2 pr-4",
              !matched && "opacity-55",
            )}
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
                <span className="truncate text-sm font-medium text-primary">{task.title}</span>
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-tertiary">
                <span className="truncate">{task.source.label}</span>
                {/* Its parent is not in the tree: named, since nothing above it shows. */}
                {task.parent && level === 1 && <TaskParentMark parent={task.parent} />}
              </span>
            </span>
            {task.blocked && <TaskBlockedMark blockedBy={task.blockedBy} />}
            {task.subtasks && (
              <span className="hidden sm:inline-flex">
                <TaskSubtaskMark subtasks={task.subtasks} />
              </span>
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
