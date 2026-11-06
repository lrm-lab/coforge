import type { TaskView } from "@lrm/coforge-sdk/internal";
import type { PointerEvent, ReactNode } from "react";

import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { ProjectImage } from "#src/features/projects/project-image";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { Folder } from "@untitledui/icons";

import type { FilterableTask } from "./task-filters";
import { openBlockers, type TaskRelations } from "./task-relation-edits";
import { TaskParentMark, TaskSubtaskMark, TaskBlockedMark } from "./task-relations";
import { TaskCardLabels } from "./task-labels";
import { TaskLabelChip } from "./task-label-chip";
import { TaskPriorityIcon } from "./task-priority-icon";
import { TaskOwnerAvatar } from "./task-owner";
import { TaskStatusIcon } from "./task-status-icon";
import type { TaskControls } from "./task-workflow";

/**
 * Parts the viewer hid on a Task board (Display → Show): the stored choice is a class on
 * <html> (`features/settings/task-display-fields.ts`), and only a card inside a board
 * (`data-task-board`) follows it, so other surfaces always show every part. CSS alone, so a
 * change never re-renders the cards. A separator hides with whatever it would separate from.
 */
const HIDDEN_ON_BOARD = {
  number: "[.task-hide-number_[data-task-board]_&]:hidden",
  source: "[.task-hide-source_[data-task-board]_&]:hidden",
  project: "[.task-hide-project_[data-task-board]_&]:hidden",
  owner: "[.task-hide-owner_[data-task-board]_&]:hidden",
};

// A bottom row held only for an owner the viewer hid goes too, except where it holds the tools
// (a touch pointer).
const PROJECT_OWNER_KEEPS_TOOLS = "[.task-hide-owner_[data-task-board]_&]:any-pointer-coarse:flex";

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
  if (list) {
    // One line: number, status, title, then the pills, the owner and the row's own controls.
    return (
      <article
        onPointerEnter={onPointerEnter}
        className="relative flex min-h-10 items-center gap-3 px-4 py-1.5 transition-colors hover:bg-primary_hover"
      >
        <span
          className={cn("w-9 shrink-0 text-xs text-tertiary tabular-nums", HIDDEN_ON_BOARD.number)}
        >
          #{task.number}
        </span>
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
          <Pill className={cn("hidden sm:inline-flex", HIDDEN_ON_BOARD.source)}>
            <span className="truncate">{source}</span>
          </Pill>
        )}
        {task.labels?.length ? (
          <span className="hidden shrink-0 sm:inline-flex">
            <TaskCardLabels labels={task.labels} />
          </span>
        ) : null}
        {project && (
          <ProjectPill
            project={project}
            className={cn("hidden sm:inline-flex", HIDDEN_ON_BOARD.project)}
          />
        )}
        <span className={HIDDEN_ON_BOARD.owner}>
          <TaskOwnerAvatar owner={task.owner} />
        </span>
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
        {source && (
          <span
            className={cn("min-w-0 truncate font-medium text-secondary", HIDDEN_ON_BOARD.source)}
          >
            {source}
          </span>
        )}
        <span className={cn("shrink-0 text-quaternary", HIDDEN_ON_BOARD.number)}>
          #{task.number}
        </span>
        {task.priority && task.priority !== "none" && (
          <TaskPriorityIcon
            priority={task.priority}
            className="ml-auto size-3.5 text-fg-quaternary"
          />
        )}
      </div>
      <h3 className="text-sm font-medium text-primary [overflow-wrap:anywhere]">
        {renderTitle(<span className="line-clamp-2">{task.title}</span>)}
      </h3>
      {task.description && (
        <p className="-mt-1 line-clamp-2 text-sm text-tertiary [overflow-wrap:anywhere]">
          {task.description}
        </p>
      )}
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
        <div className={cn("flex min-w-0 items-center gap-1.5", !label && HIDDEN_ON_BOARD.project)}>
          {label && <TaskLabelChip label={label} />}
          {moreLabels.length > 0 && (
            <span className="text-xs text-tertiary">+{moreLabels.length}</span>
          )}
          {/* The Project gives way to the label: it truncates rather than leave the card. */}
          {project && (
            <ProjectPill project={project} className={cn("shrink", HIDDEN_ON_BOARD.project)} />
          )}
        </div>
      )}
      {steps && steps.total > 0 && (
        <div className="flex items-center gap-2">
          <ProgressBarBase
            value={steps.finished}
            max={steps.total}
            className="h-1.5 flex-1"
            progressClassName="bg-fg-brand-primary"
          />
          <span className="text-xs text-tertiary tabular-nums">
            {m.task_board_steps({ finished: steps.finished, total: steps.total })}
          </span>
        </div>
      )}
      {/* Its owner, and later how much talk it holds (task #598: the comment count, from the
          board's read, goes at this row's end once the row carries one). With a touch pointer the
          tools sit at this row's end, so it keeps room for them and stays even with no owner. */}
      <div
        className={cn(
          "flex min-h-7 items-center gap-2",
          tools && "any-pointer-coarse:pr-16",
          HIDDEN_ON_BOARD.owner,
          tools && PROJECT_OWNER_KEEPS_TOOLS,
        )}
      >
        <TaskOwnerAvatar owner={task.owner} />
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
