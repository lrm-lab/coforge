import { taskNameLabel } from "@lrm/coforge-sdk/internal";
import type { TaskLink, TaskName, TaskTreeNode } from "@lrm/coforge-sdk/internal";
import { useState, type ReactNode } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { ChevronDown, ChevronRight, CornerLeftUp } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { POPOVER_MOTION } from "#src/utils/popover-motion";

import { isFinishedStatus } from "./finished-tasks";
import { TaskLocator, taskMetaLabel } from "./task-chip";
import { SubtaskProgressRing } from "./subtask-progress-ring";
import { TaskOwnerAvatar } from "./task-owner";
import { openBlockers, type TaskRelations, type VisibleTaskName } from "./task-relation-edits";
import { TaskStatusIcon } from "./task-status-icon";

export function TaskBlockedMark({
  blockedBy,
  interactive = true,
}: {
  blockedBy: readonly (TaskName | TaskLink)[];
  interactive?: boolean;
}) {
  const [activated, setActivated] = useState(false);
  const open = openBlockers(blockedBy);
  const first = open[0];
  if (!first) return null;
  const name = first.hidden ? m.tasks_ref_hidden() : taskMetaLabel(first);
  const text =
    open.length > 1
      ? m.tasks_blocked_by_count({ count: open.length })
      : m.tasks_blocked_by_mark({ name });
  if (!interactive && !activated) {
    return (
      <AriaButton
        onPress={() => setActivated(true)}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums outline-hidden hover:text-secondary focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        {text}
      </AriaButton>
    );
  }
  return (
    <AriaDialogTrigger defaultOpen={activated}>
      <AriaButton className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums outline-hidden hover:text-secondary focus-visible:ring-2 focus-visible:ring-focus-ring">
        {text}
      </AriaButton>
      <AriaPopover
        placement="bottom start"
        offset={6}
        className={cn(
          "w-72 max-w-[calc(100vw-2rem)] origin-(--trigger-anchor-point) rounded-xl bg-primary shadow-lg ring-1 ring-secondary_alt outline-hidden will-change-transform",
          POPOVER_MOTION,
        )}
      >
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
      </AriaPopover>
    </AriaDialogTrigger>
  );
}

function CardMark({
  children,
  label,
  interactive = true,
}: {
  children: ReactNode;
  label: string;
  interactive?: boolean;
}) {
  if (!interactive) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums">
        <span className="sr-only">{label}</span>
        {children}
      </span>
    );
  }
  return (
    <Tooltip title={label}>
      <TooltipTrigger className="inline-flex shrink-0 items-center gap-1 rounded-sm text-xs whitespace-nowrap text-tertiary tabular-nums focus-visible:ring-2 focus-visible:ring-focus-ring">
        {children}
      </TooltipTrigger>
    </Tooltip>
  );
}

export function TaskParentMark({
  parent,
  interactive = true,
}: {
  parent: TaskLink;
  interactive?: boolean;
}) {
  const text = parent.hidden
    ? m.tasks_parent()
    : m.tasks_parent_mark({ name: taskNameLabel(parent) });
  return (
    <CardMark
      interactive={interactive}
      label={parent.hidden ? `${text} (${m.tasks_hidden()})` : `${text} ${parent.title}`}
    >
      <CornerLeftUp aria-hidden="true" className="size-3 shrink-0 text-fg-quaternary" />
      {text}
    </CardMark>
  );
}

export function TaskSubtaskMark({
  subtasks,
  interactive = true,
}: {
  subtasks: NonNullable<TaskRelations["subtasks"]>;
  interactive?: boolean;
}) {
  return (
    <CardMark interactive={interactive} label={m.tasks_subtasks_finished(subtasks)}>
      <SubtaskProgressRing {...subtasks} className="size-3" />
      {m.tasks_subtasks_mark(subtasks)}
    </CardMark>
  );
}

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
      <TaskLocator task={task} />
    </>
  );
}

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
      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      <TaskLinkText task={task} />
    </AriaButton>
  );
}

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
  const indent = { paddingInlineStart: `${Math.min(depth, 5) * 1.25}rem` };
  if (node.hidden)
    return (
      <li
        className="flex min-h-8 min-w-0 items-center gap-2 rounded-md pe-1.5 text-sm"
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
        className="flex min-h-8 min-w-0 items-center gap-2 rounded-md pe-1.5 hover:bg-primary_hover"
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
            className="rtl:[&:not([aria-expanded=true])_svg]:rotate-180"
          />
        ) : (
          <span aria-hidden="true" className="size-6 shrink-0" />
        )}
        <TaskStatusIcon status={node.status} />
        <TaskLinkTarget task={node} onOpen={onOpen} />
        {node.blocked && <TaskBlockedMark blockedBy={node.blockedBy} />}
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
