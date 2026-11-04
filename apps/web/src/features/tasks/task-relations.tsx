import { taskNameLabel } from "@lrm/coforge-sdk/internal";
import type { TaskLink, TaskName, TaskTreeNode } from "@lrm/coforge-sdk/internal";
import type { ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { ChevronDown, ChevronRight, CornerLeftUp } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";

import { isFinishedStatus } from "./finished-tasks";
import { taskMetaLabel } from "./task-chip";
import { SubtaskProgressRing } from "./subtask-progress-ring";
import { TaskOwnerAvatar } from "./task-owner";
import { openBlockers, type TaskRelations, type VisibleTaskName } from "./task-relation-edits";
import { TaskStatusIcon } from "./task-status-icon";

/**
 * Task dependencies and sub-tasks as a Task view carries them, named as Linear names them: the
 * Tasks a Task is blocked by, its parent task and its sub-tasks (the SDK's `TaskLink` and
 * `TaskTreeNode`). A related Task the reader cannot see (neither in this channel nor in a public
 * one) comes as `hidden`, with only its status: it still counts towards being blocked.
 */

/**
 * "Waiting on #388", or "Waiting on 3 tasks", while anything still blocks a Task, and nothing at
 * all otherwise. Grey like the rest of the card: being blocked is not an error. The whole list is
 * in a tooltip, reachable by keyboard.
 */
export function TaskBlockedMark({ blockedBy }: { blockedBy: readonly (TaskName | TaskLink)[] }) {
  const open = openBlockers(blockedBy);
  const first = open[0];
  if (!first) return null;
  const name = first.hidden ? m.tasks_ref_hidden() : taskMetaLabel(first);
  return (
    <Tooltip
      title={
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{m.tasks_blocked_by()}</span>
          {open.map((task, index) => (
            <span key={task.hidden ? `hidden-${index}` : taskNameLabel(task)} className="truncate">
              {task.hidden
                ? m.tasks_ref_hidden()
                : "title" in task
                  ? `${task.title} ${taskMetaLabel(task)}`
                  : taskMetaLabel(task)}
            </span>
          ))}
        </span>
      }
    >
      {/* Never cut short: the source or title beside it gives way first. */}
      <TooltipTrigger className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums focus-visible:ring-2 focus-visible:ring-focus-ring">
        {open.length > 1
          ? m.tasks_blocked_by_count({ count: open.length })
          : m.tasks_blocked_by_mark({ name })}
      </TooltipTrigger>
    </Tooltip>
  );
}

/** A grey note beside a card's number, like the number itself, named in full in its tooltip. */
function CardMark({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Tooltip title={label}>
      <TooltipTrigger className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums focus-visible:ring-2 focus-visible:ring-focus-ring">
        {children}
      </TooltipTrigger>
    </Tooltip>
  );
}

/** "↳ Parent task #185" on a sub-task. */
export function TaskParentMark({ parent }: { parent: TaskLink }) {
  const text = parent.hidden
    ? m.tasks_parent()
    : m.tasks_parent_mark({ name: taskNameLabel(parent) });
  return (
    <CardMark label={parent.hidden ? `${text} · ${m.tasks_hidden()}` : `${text} ${parent.title}`}>
      <CornerLeftUp aria-hidden="true" className="size-3 shrink-0 text-fg-quaternary" />
      {text}
    </CardMark>
  );
}

/** "Sub-tasks 3/5" on a Task with sub-tasks: how many of them are done or closed. */
export function TaskSubtaskMark({
  subtasks,
}: {
  subtasks: NonNullable<TaskRelations["subtasks"]>;
}) {
  return (
    <CardMark label={m.tasks_subtasks_finished(subtasks)}>
      <SubtaskProgressRing {...subtasks} className="size-3" />
      {m.tasks_subtasks_mark(subtasks)}
    </CardMark>
  );
}

/** The text of a related Task: its name and title, or that it is in a channel the reader cannot
 * see. A finished Task reads quieter. */
function TaskLinkText({ task }: { task: TaskLink }) {
  if (task.hidden)
    return <span className="min-w-0 truncate text-tertiary">{m.tasks_ref_hidden()}</span>;
  return (
    <>
      <span
        className={cn(
          "min-w-0 truncate",
          isFinishedStatus(task.status) ? "text-tertiary" : "text-primary",
        )}
      >
        {task.title}
      </span>
      <span className="shrink-0 text-xs text-tertiary tabular-nums">{taskMetaLabel(task)}</span>
    </>
  );
}

/** A related Task's text, as the button that opens it. One the reader cannot see, or where the
 * popup has no way to open a Task, is a plain line. */
function TaskLinkTarget({
  task,
  onOpen,
}: {
  task: TaskLink;
  onOpen?: (task: VisibleTaskName) => void;
}) {
  if (task.hidden || !onOpen)
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <TaskLinkText task={task} />
      </span>
    );
  return (
    <AriaButton
      onPress={() => onOpen(task)}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <TaskLinkText task={task} />
    </AriaButton>
  );
}

/** One related Task as a row: its status, name and title, opening that Task. */
export function TaskLinkRow({
  task,
  onOpen,
  trailing,
}: {
  task: TaskLink;
  onOpen?: (task: VisibleTaskName) => void;
  trailing?: ReactNode;
}) {
  return (
    <li className="group/row flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-primary_hover">
      <TaskStatusIcon status={task.status} />
      <TaskLinkTarget task={task} onOpen={onOpen} />
      {trailing}
    </li>
  );
}

/** A sub-task and, unless folded, its own sub-tasks, indented a step per level. */
export function TreeRow({
  node,
  depth,
  folded,
  onToggle,
  onOpen,
}: {
  node: TaskTreeNode;
  depth: number;
  folded: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onOpen?: (task: VisibleTaskName) => void;
}) {
  const indent = { paddingLeft: `${depth * 1.25}rem` };
  // A sub-task the reader cannot see: its status, and nothing under it to unfold.
  if (node.hidden)
    return (
      <li
        className="flex min-h-8 min-w-0 items-center gap-2 rounded-md pr-1.5 text-sm"
        style={indent}
      >
        <span aria-hidden="true" className="size-6 shrink-0" />
        <TaskStatusIcon status={node.status} />
        <span className="min-w-0 truncate text-tertiary">{m.tasks_ref_hidden()}</span>
      </li>
    );
  const key = taskNameLabel(node);
  const open = !folded.has(key);
  const hasChildren = node.children.length > 0;
  return (
    <>
      <li
        className="flex min-h-8 min-w-0 items-center gap-2 rounded-md pr-1.5 hover:bg-primary_hover"
        style={indent}
      >
        {hasChildren ? (
          <ButtonUtility
            icon={open ? ChevronDown : ChevronRight}
            size="xs"
            color="tertiary"
            aria-expanded={open}
            aria-label={m.tasks_subtasks_toggle({ name: key })}
            onClick={() => onToggle(key)}
          />
        ) : (
          <span aria-hidden="true" className="size-6 shrink-0" />
        )}
        <TaskStatusIcon status={node.status} />
        <TaskLinkTarget task={node} onOpen={onOpen} />
        {node.blocked && <TaskBlockedMark blockedBy={node.blockedBy} />}
        {/* No one on it: nothing, rather than a column of empty circles. */}
        {node.owner && <TaskOwnerAvatar owner={node.owner} />}
      </li>
      {open &&
        node.children.map((child, index) => (
          <TreeRow
            key={child.hidden ? `hidden-${index}` : taskNameLabel(child)}
            node={child}
            depth={depth + 1}
            folded={folded}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
    </>
  );
}
