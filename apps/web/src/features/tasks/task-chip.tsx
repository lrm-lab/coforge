import type { TaskView } from "@lrm/coforge-sdk/internal";
import { Lock01 } from "@untitledui/icons";
import { useRef, type ReactNode } from "react";
import { Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import { HoverPopover } from "#src/components/ui/hover-popover";
import { useChannelMembers } from "#src/features/conversations/channel-members";
import { GroupAvatar } from "#src/features/conversations/group-avatar";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { priorityLabel } from "./task-history-more";
import { TaskLabelChip } from "./task-label-chip";
import { taskMetaLabel } from "./task-meta-label";
import { TaskPerson } from "./task-owner";
import { TaskPriorityIcon } from "./task-priority-icon";
import { TaskStatusIcon, statusLabel } from "./task-status-icon";

export { taskMetaLabel };

type ChipTask = Pick<TaskView, "number" | "title" | "status" | "owner"> &
  Partial<Pick<TaskView, "priority" | "labels">>;

export function TaskLocator({
  task,
  shrink = false,
}: {
  task: { number: number; channel?: string | null };
  shrink?: boolean;
}) {
  return (
    <span
      data-task-locator
      className={cx(
        "flex items-center gap-1.5 text-xs text-tertiary tabular-nums",
        shrink ? "min-w-0" : "shrink-0",
      )}
    >
      <span className="shrink-0">#{task.number}</span>
      {task.channel && <ChannelPlace name={task.channel} />}
    </span>
  );
}

function ChannelPlace({ name }: { name: string }) {
  const members = useChannelMembers({ name });
  return (
    <span className="flex min-w-0 items-center gap-1">
      {members?.length ? <GroupAvatar members={members} className="avatar-group-xs" /> : "#"}
      <span className="max-w-[12em] truncate">{name}</span>
    </span>
  );
}

export function TaskChip({
  task,
  channel,
  place,
  onPress,
}: {
  task: ChipTask;
  channel?: string;
  place?: string;
  onPress?: () => void;
}) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const meta = channel
    ? taskMetaLabel({ number: task.number, channel })
    : place
      ? `#${task.number} ${place}`
      : `#${task.number}`;
  const handlePress = onPress
    ? () => {
        const host = chipRef.current?.parentElement ?? chipRef.current;
        if (host) {
          rememberSharedRect(`task-frame:${task.number}`, host);
          rememberSharedRect(`task-title:${task.number}`, chipRef.current ?? host);
        }
        onPress();
      }
    : undefined;
  return (
    <HoverPopover
      label={`${task.title}, ${statusLabel(task.status)}, ${meta}`}
      inline
      onPress={handlePress}
      className="w-72 p-3"
      triggerClassName="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md bg-secondary px-1.5 align-middle leading-6 hover:bg-secondary_hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      trigger={
        <>
          <TaskStatusIcon status={task.status} className="size-3.5 shrink-0" />
          <span
            ref={chipRef}
            data-task-status={task.status}
            className="max-w-[20em] min-w-0 truncate font-medium text-primary max-sm:max-w-[10em]"
          >
            {task.title}
          </span>
        </>
      }
    >
      <TaskPeek task={task} meta={channel ? <TaskLocator task={{ ...task, channel }} /> : meta} />
    </HoverPopover>
  );
}

const MAX_PEEK_LABELS = 6;

function TaskPeek({ task, meta }: { task: ChipTask; meta: ReactNode }) {
  const labels = task.labels ?? [];
  const visibleLabels = labels.slice(0, MAX_PEEK_LABELS);
  const overflowLabels = labels.length - visibleLabels.length;

  return (
    <div className="flex min-w-0 flex-col">
      <p className="min-w-0 truncate text-xs font-medium text-tertiary tabular-nums">{meta}</p>
      <p dir="auto" className="mt-1 line-clamp-3 text-sm font-semibold wrap-anywhere text-primary">
        {task.title}
      </p>
      <div className="mt-3 flex min-w-0 flex-col gap-2 border-t border-secondary pt-3 text-sm text-secondary">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <TaskStatusIcon status={task.status} />
            {statusLabel(task.status)}
          </span>
          {task.priority && task.priority !== "none" && (
            <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
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
        {visibleLabels.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {visibleLabels.map((label) => (
              <TaskLabelChip key={label.id} label={label} className="min-w-0 shrink" />
            ))}
            {overflowLabels > 0 && (
              <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-tertiary tabular-nums">
                +{overflowLabels}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function HiddenTaskChip() {
  return (
    <Tooltip title={m.tasks_ref_hidden_hint()}>
      <Focusable>
        <span
          tabIndex={0}
          className="inline-flex items-center gap-1 align-baseline text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-focus-ring"
        >
          <Lock01 aria-hidden="true" className="size-3.5 self-center" />
          {m.tasks_ref_hidden()}
        </span>
      </Focusable>
    </Tooltip>
  );
}
