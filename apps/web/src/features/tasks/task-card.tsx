import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { PointerEvent, ReactNode } from "react";

import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { ProjectImage } from "#src/features/projects/project-image";
import { cn } from "#src/lib/utils";
import { formatMonthDay } from "#src/lib/dates";
import { useTimeZone } from "#src/lib/time-zone-context";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { taskStepsProgressClass } from "./task-steps-progress";
import { Folder, MessageChatCircle, Paperclip } from "@untitledui/icons";

import type { FilterableTask } from "./task-filters";
import { openBlockers, type TaskRelations } from "./task-relation-edits";
import { TaskParentMark, TaskSubtaskMark, TaskBlockedMark } from "./task-relations";
import { TaskCardLabels } from "./task-labels";
import { TaskLabelChip } from "./task-label-chip";
import { priorityLabel } from "./task-history-more";
import { TaskPriorityIcon } from "./task-priority-icon";
import { TaskOwnerAvatar } from "./task-owner";
import { TaskStatusIcon } from "./task-status-icon";
import type { TaskControls } from "./task-workflow";

/** When the Task was made, at a card's foot (Frank, 11-06): the day, as narrow columns allow. */
function TaskCreatedAt({ at }: { at: string | Date }) {
  const timeZone = useTimeZone();
  return (
    <span className="shrink-0 text-xs whitespace-nowrap text-tertiary tabular-nums">
      {formatMonthDay(at, timeZone, getLocale())}
    </span>
  );
}

/** One of a card's counts at its foot: nothing while there are none. */
function TaskCount({
  icon: Icon,
  count,
  label,
}: {
  icon: typeof Paperclip;
  count: number | undefined;
  label: (count: number) => string;
}) {
  if (!count) return null;
  return (
    <span
      role="img"
      aria-label={label(count)}
      className="flex shrink-0 items-center gap-1 text-xs text-tertiary tabular-nums"
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {count}
    </span>
  );
}

/** Classes for the link or button a caller wraps around the title. */
export const TASK_TITLE_CLASS =
  "block w-full rounded-sm text-left outline-none hover:underline hover:decoration-fg-quaternary hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-focus-ring";

/** A source or Project as a small outlined pill, as Linear shows an issue's labels. */
function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 max-w-40 min-w-0 shrink-0 items-center gap-1 rounded-full border border-secondary px-2 text-xs text-secondary",
        className,
      )}
    >
      {children}
    </span>
  );
}

type TaskCardProject = Pick<NonNullable<FilterableTask["project"]>, "name" | "iconUrl">;

/**
 * A Project pill leads with the Project's own icon, as Linear's project label does, and with the
 * Projects nav icon when none was uploaded: a first letter this small reads as an owner avatar.
 */
function ProjectPill({ project, className }: { project: TaskCardProject; className?: string }) {
  return (
    <Pill className={className}>
      <ProjectImage
        name={project.name}
        url={project.iconUrl ?? null}
        fallback={<Folder className="size-3 text-fg-quaternary" />}
        className="size-3.5 rounded-xs bg-transparent"
      />
      <span className="truncate">{project.name}</span>
    </Pill>
  );
}

/**
 * One task on the board (a card) or in the list (a row), laid out as Linear lays out issues. The
 * caller supplies what differs per surface: the clickable title, where the task lives and its
 * menu.
 */
export function TaskCard({
  task,
  renderTitle,
  source,
  project,
  controls,
  menu,
  list,
  relations,
  onReach,
}: {
  task: TaskView;
  /** Wraps the title text in the surface's link or button. */
  renderTitle: (title: ReactNode) => ReactNode;
  /** The conversation the task belongs to, on surfaces that mix conversations. */
  source?: string;
  /** The Project the task's conversation belongs to, on surfaces that mix Projects; null when it
   * has none. */
  project?: TaskCardProject | null;
  controls: TaskControls;
  menu?: ReactNode;
  list: boolean;
  /** What the task waits on, the Task it is part of and its sub-tasks' progress. */
  relations?: TaskRelations;
  /** Someone is reaching for the card: a mouse came over it. Not a touch or a pen, which can
   * come down on a button with no hover first, and whose press must land on what it started on. */
  onReach?: () => void;
}) {
  const onPointerEnter =
    onReach && ((event: PointerEvent) => event.pointerType === "mouse" && onReach());
  const blocked = relations?.blocked ? <TaskBlockedMark blockedBy={relations.blockedBy} /> : null;
  const parent = relations?.parent ? <TaskParentMark parent={relations.parent} /> : null;
  const subtasks = relations?.subtasks ? <TaskSubtaskMark subtasks={relations.subtasks} /> : null;
  const tools = (controls.handle || menu) && (
    <div className="flex shrink-0 items-center">
      {controls.handle}
      {menu}
    </div>
  );
  const priorityMark = (className: string) =>
    task.priority &&
    task.priority !== "none" && (
      <TaskPriorityIcon
        priority={task.priority}
        label={m.tasks_priority_mark({ priority: priorityLabel(task.priority) })}
        className={className}
      />
    );
  if (list) {
    // One line: priority, number, status, title, then the pills, the owner and the row's own controls.
    return (
      <article
        onPointerEnter={onPointerEnter}
        className="relative flex min-h-10 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-primary_hover"
      >
        {/* A slot of its own, so the titles line up with or without a mark. */}
        <span className="flex size-3.5 shrink-0">{priorityMark("size-3.5")}</span>
        <span className="w-9 shrink-0 text-xs text-tertiary tabular-nums">#{task.number}</span>
        <TaskStatusIcon status={task.status} />
        <h3 className="min-w-0 flex-1 text-sm font-medium text-primary">
          {renderTitle(<span className="line-clamp-1">{task.title}</span>)}
        </h3>
        {blocked}
        {(parent || subtasks) && (
          <span className="hidden shrink-0 items-center gap-2 text-xs text-tertiary sm:inline-flex">
            {parent}
            {subtasks}
          </span>
        )}
        {source && (
          <Pill className="hidden sm:inline-flex">
            <span className="truncate">{source}</span>
          </Pill>
        )}
        {task.labels?.length ? (
          <span className="hidden shrink-0 sm:inline-flex">
            <TaskCardLabels labels={task.labels} />
          </span>
        ) : null}
        {project && <ProjectPill project={project} className="hidden sm:inline-flex" />}
        <TaskOwnerAvatar owner={task.owner} />
        {tools}
      </article>
    );
  }
  // What still blocks it, named in a line of its own under the title (Tasks v2 only: `relations`).
  const waitingOn = relations && openBlockers(relations.blockedBy).find((task) => !task.hidden);
  const steps = relations?.subtasks;
  const [label, ...moreLabels] = task.labels ?? [];
  return (
    <article
      onPointerEnter={onPointerEnter}
      className="group relative flex flex-col gap-2.5 rounded-xl border border-secondary bg-primary p-3 shadow-xs transition-shadow hover:shadow-md"
    >
      {/* The channel leads: a number counts within its channel, so two cards can share one. */}
      <div className="flex h-4 items-center gap-1.5 text-xs tabular-nums">
        {source && <span className="min-w-0 truncate font-medium text-secondary">{source}</span>}
        <span className="shrink-0 text-quaternary">#{task.number}</span>
        {priorityMark("ml-auto size-3.5 text-fg-quaternary")}
      </div>
      <h3 className="text-sm font-medium text-primary [overflow-wrap:anywhere]">
        {renderTitle(<span className="line-clamp-2">{task.title}</span>)}
      </h3>
      {waitingOn ? (
        <p className="-mt-1 flex items-start gap-1.5 text-xs text-warning-primary">
          <span
            aria-hidden="true"
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-warning-secondary"
          />
          <span className="line-clamp-2">
            {m.task_board_waiting({ number: waitingOn.number, title: waitingOn.title })}
          </span>
        </p>
      ) : (
        // Blocked only by Tasks the viewer cannot see: there is nothing to name, only the count.
        blocked
      )}
      {(label || project) && (
        <div className="flex min-w-0 items-center gap-1.5">
          {label && <TaskLabelChip label={label} />}
          {moreLabels.length > 0 && (
            <span className="text-xs text-tertiary">+{moreLabels.length}</span>
          )}
          {/* The Project gives way to the label: it truncates rather than leave the card. */}
          {project && <ProjectPill project={project} className="shrink" />}
        </div>
      )}
      {steps && steps.total > 0 && (
        <div className="flex items-center gap-2">
          <ProgressBarBase
            value={steps.finished}
            max={steps.total}
            className="h-1.5 flex-1"
            progressClassName={taskStepsProgressClass(steps.finished, steps.total)}
          />
          <span className="text-xs text-tertiary tabular-nums">
            {m.task_board_steps({ finished: steps.finished, total: steps.total })}
          </span>
        </div>
      )}
      {/* Its owner, then how much talk it holds and when it was made. With a touch pointer the
          tools sit at this row's end, so it keeps room for them and stays even with no owner. */}
      <div
        className={cn(
          "flex min-h-7 items-center justify-between gap-2",
          tools && "any-pointer-coarse:pr-16",
        )}
      >
        <TaskOwnerAvatar owner={task.owner} />
        <span className="flex min-w-0 items-center gap-3">
          <TaskCount
            icon={MessageChatCircle}
            count={task.replyCount}
            label={(count) => m.task_card_replies({ count })}
          />
          <TaskCount
            icon={Paperclip}
            count={task.fileCount}
            label={(count) => m.task_card_files({ count })}
          />
          <TaskCreatedAt at={task.createdAt} />
        </span>
      </div>
      {tools && (
        // After the title in the DOM so assistive tech names the task first. With a mouse, over
        // the top corner (the priority) while hovered or focused; with a touch pointer, always
        // shown at the bottom row's end, so the priority is never covered for good.
        <div className="absolute top-2 right-1.5 rounded-md bg-primary opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 any-pointer-coarse:top-auto any-pointer-coarse:bottom-2.5 any-pointer-coarse:opacity-100">
          {tools}
        </div>
      )}
    </article>
  );
}
