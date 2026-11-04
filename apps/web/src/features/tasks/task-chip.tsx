import type { TaskView } from "@lrm/coforge-sdk/internal";
import { Lock01 } from "@untitledui/icons";
import { Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { m } from "#src/paraglide/messages";
import { priorityLabel } from "./task-history-more";
import { TaskPriorityIcon } from "./task-priority-icon";
import { TaskLabelChip } from "./task-label-chip";
import { TaskPerson } from "./task-owner";
import { TaskStatusIcon, statusLabel } from "./task-status-icon";

type ChipTask = Pick<TaskView, "number" | "title" | "status" | "owner"> &
  Partial<Pick<TaskView, "priority" | "labels">>;

/** A Task's grey locator after its title: `#7`, or `#7 · #design` for another channel's. */
export function taskMetaLabel(task: { number: number; channel?: string | null }) {
  return task.channel ? `#${task.number} · #${task.channel}` : `#${task.number}`;
}

/**
 * A Task named in a message, or the Task a message became: its status icon and title, as often
 * as people read it, and no more. The title is cut short, so a sentence with several Tasks in it
 * stays a sentence: about 20 characters of Chinese in a message, about 10 on a phone. Its number,
 * where it lives, who holds it, what it waits on and how far its sub-tasks are, are rarer needs
 * and live in the peek, with the whole title (task #449, Frank 11-04); a press opens it.
 */
export function TaskChip({
  task,
  place,
  onPress,
}: {
  task: ChipTask;
  /** Where the Task lives, for another conversation's (`#design`, `DM with @ada`). */
  place?: string;
  onPress?: () => void;
}) {
  const meta = place ? `#${task.number} · ${place}` : `#${task.number}`;
  return (
    <HoverPopover
      label={`${task.title}, ${statusLabel(task.status)}, ${meta}`}
      inline
      onPress={onPress}
      className="w-72 p-3"
      triggerClassName="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md bg-secondary px-1.5 align-middle leading-6 hover:bg-secondary_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      trigger={
        <>
          <TaskStatusIcon status={task.status} className="size-3.5 shrink-0" />
          <span
            data-task-status={task.status}
            className="max-w-[20em] min-w-0 truncate font-medium text-primary max-sm:max-w-[10em]"
          >
            {task.title}
          </span>
        </>
      }
    >
      <TaskPeek task={task} meta={meta} />
    </HoverPopover>
  );
}

/**
 * The peek, read top down: where the Task is (its number and place) over its whole title, then on
 * one line its status, priority and who holds it, each led by its icon rather than a label, then
 * its labels (task #449, Frank 11-04).
 */
function TaskPeek({ task, meta }: { task: ChipTask; meta: string }) {
  return (
    <div className="flex flex-col">
      <p className="text-xs font-medium text-tertiary tabular-nums">{meta}</p>
      <p className="mt-1 text-sm font-semibold text-primary">{task.title}</p>
      <div className="mt-3 flex flex-col gap-2 border-t border-secondary pt-3 text-sm text-secondary">
        {/* One line, in the order the facts are asked: where it stands, how urgent it is, who
            holds it (Linear's docs list a Task's state, then its urgency). */}
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex shrink-0 items-center gap-1.5">
            <TaskStatusIcon status={task.status} />
            {statusLabel(task.status)}
          </span>
          {task.priority && task.priority !== "none" && (
            <span className="flex shrink-0 items-center gap-1.5">
              <TaskPriorityIcon priority={task.priority} />
              {priorityLabel(task.priority)}
            </span>
          )}
          {task.owner ? (
            <TaskPerson person={task.owner} className="min-w-0 font-normal text-secondary" />
          ) : (
            <span className="truncate text-tertiary">{m.tasks_unassigned()}</span>
          )}
        </div>
        {task.labels && task.labels.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.labels.map((label) => (
              <TaskLabelChip key={label.id} label={label} className="min-w-0 shrink" />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A Task the reader cannot see: said so, and nothing more — not its number, status or place. */
export function HiddenTaskChip() {
  return (
    <Tooltip title={m.tasks_ref_hidden_hint()}>
      <Focusable>
        <span className="inline-flex items-center gap-1 align-baseline text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-focus-ring">
          <Lock01 aria-hidden="true" className="size-3.5 self-center" />
          {m.tasks_ref_hidden()}
        </span>
      </Focusable>
    </Tooltip>
  );
}
