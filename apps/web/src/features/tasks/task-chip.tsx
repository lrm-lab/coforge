import type { TaskView } from "@lrm/coforge-sdk/internal";
import { Lock01 } from "@untitledui/icons";
import { Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { m } from "#src/paraglide/messages";
import { TaskPerson } from "./task-owner";
import { TaskStatusIcon, statusLabel } from "./task-status-icon";

type ChipTask = Pick<TaskView, "number" | "title" | "status" | "owner">;

/** A Task's grey locator after its title: `#7`, or `#7 · #design` for another channel's. */
export function taskMetaLabel(task: { number: number; channel?: string | null }) {
  return task.channel ? `#${task.number} · #${task.channel}` : `#${task.number}`;
}

/**
 * A Task named in a message: its status icon and title, as often as people read it, and no more.
 * The title is cut short, so a sentence with several Tasks in it stays a sentence: about 20
 * characters of Chinese in a message, about 10 on a phone. Its number, where it lives and who
 * holds it are rarer needs and live in the peek, with the whole title; a press opens it.
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

/** The peek: the whole title, the status and who holds it, and where the Task lives. */
function TaskPeek({ task, meta }: { task: ChipTask; meta: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm font-semibold text-primary">{task.title}</p>
      <div className="flex items-center gap-3 text-sm text-secondary">
        <span className="flex items-center gap-1.5">
          <TaskStatusIcon status={task.status} />
          {statusLabel(task.status)}
        </span>
        {task.owner ? (
          <TaskPerson person={task.owner} className="font-normal text-secondary" />
        ) : (
          <span className="text-tertiary">{m.tasks_unassigned()}</span>
        )}
      </div>
      <p className="text-xs text-tertiary">{meta}</p>
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
