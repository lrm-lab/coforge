import type { TaskView } from "@lrm/coforge-sdk/internal";
import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import { useHydrated } from "@tanstack/react-router";

import { ProgressBarBase } from "#src/components/base/progress-indicators/progress-indicators";
import { ChannelPlace } from "#src/features/conversations/channel-name";
import { ProjectImage } from "#src/features/projects/project-image";
import { formatNumber } from "#src/lib/format-number";
import { rememberSharedRect } from "#src/lib/shared-element-rect";
import { cn } from "#src/lib/utils";
import { useTimeZone } from "#src/lib/time-zone-context";
import { getLocale } from "#src/paraglide/runtime";
import { m } from "#src/paraglide/messages";
import { Calendar, Folder, MessageChatCircle, Paperclip } from "@untitledui/icons";
import { formatTaskCardDate } from "./task-card-date";
import { taskStepsProgressClass } from "./task-steps-progress";

import type { FilterableTask } from "./task-filters";
import { openBlockers } from "./task-relation-edits";
import { TaskLocator } from "./task-chip";
import { TaskParentMark, TaskSubtaskMark, TaskBlockedMark } from "./task-relations";
import { TaskCardLabels } from "./task-labels";
import { TaskLabelChip } from "./task-label-chip";
import { priorityLabel } from "./task-history-more";
import { TaskPriorityIcon } from "./task-priority-icon";
import { TaskOwnerAvatar } from "./task-owner";
import { TaskStatusIcon } from "./task-status-icon";
import type { TaskControls } from "./task-workflow";

function TaskCreatedAt({
  at,
  hydrated,
  timeZone,
}: {
  at: string | Date;
  hydrated: boolean;
  timeZone: string | null | undefined;
}) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      className="shrink-0 text-xs whitespace-nowrap text-tertiary tabular-nums"
    >
      {hydrated ? formatTaskCardDate(at, timeZone, getLocale()) : "\u00A0"}
    </time>
  );
}

function TaskDueAt({
  task,
  hydrated,
  timeZone,
}: {
  task: TaskView;
  hydrated: boolean;
  timeZone: string | null | undefined;
}) {
  if (!task.dueAt) return null;
  const state = task.dueState;
  return (
    <span
      role="img"
      aria-label={
        state === "overdue"
          ? m.tasks_due_overdue()
          : state === "due_soon"
            ? m.tasks_due_soon()
            : m.tasks_due()
      }
      className={cn(
        "flex shrink-0 items-center gap-1 text-xs whitespace-nowrap tabular-nums",
        state === "overdue"
          ? "text-error-primary"
          : state === "due_soon"
            ? "text-warning-primary"
            : "text-tertiary",
      )}
    >
      <Calendar aria-hidden="true" className="size-3.5" />
      <time dateTime={new Date(task.dueAt).toISOString()}>
        {hydrated
          ? formatTaskCardDate(task.dueAt, timeZone, getLocale(), undefined, task.dueHasTime)
          : "\u00A0"}
      </time>
    </span>
  );
}

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
      {formatNumber(count)}
    </span>
  );
}

export const TASK_TITLE_CLASS =
  "block w-full rounded-sm text-start outline-none hover:underline hover:decoration-fg-quaternary hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-focus-ring any-pointer-coarse:relative any-pointer-coarse:after:absolute any-pointer-coarse:after:inset-x-0 any-pointer-coarse:after:-inset-y-2.5";

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

export function TaskCard({
  task,
  renderTitle,
  source,
  channel,
  project,
  controls,
  menu,
  list,
  selected = false,
  reached = true,
  onReach,
}: {
  task: TaskView;
  renderTitle: (title: ReactNode) => ReactNode;
  source?: string;
  channel?: string | null;
  project?: TaskCardProject | null;
  controls: TaskControls;
  menu?: ReactNode;
  list: boolean;
  selected?: boolean;
  reached?: boolean;
  onReach?: () => void;
}) {
  const hydrated = useHydrated();
  const timeZone = useTimeZone();
  const cardRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!selected) return;
    cardRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  const rememberCard = () => {
    if (cardRef.current) {
      rememberSharedRect(`task-frame:${task.id}`, cardRef.current);
      rememberSharedRect(`task-frame:${task.number}`, cardRef.current);
    }
    if (titleRef.current) {
      rememberSharedRect(`task-title:${task.id}`, titleRef.current);
      rememberSharedRect(`task-title:${task.number}`, titleRef.current);
    }
  };
  const onPointerEnter =
    onReach && ((event: PointerEvent) => event.pointerType === "mouse" && onReach());
  const blocked = task.blocked ? (
    <TaskBlockedMark blockedBy={task.blockedBy} interactive={reached} />
  ) : null;
  const parent = task.parent ? <TaskParentMark parent={task.parent} interactive={reached} /> : null;
  const subtasks = task.subtasks ? (
    <TaskSubtaskMark subtasks={task.subtasks} interactive={reached} />
  ) : null;
  const handle =
    controls.handle && list ? (
      <span className="hidden sm:contents">{controls.handle}</span>
    ) : (
      controls.handle
    );
  const tools = (handle || menu) && (
    <div className="flex shrink-0 items-center">
      {handle}
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
    return (
      <article
        ref={cardRef}
        data-selected={selected ? "true" : undefined}
        aria-current={selected ? "true" : undefined}
        onClickCapture={rememberCard}
        onPointerEnter={onPointerEnter}
        onFocusCapture={onReach}
        className={cn(
          "relative flex min-h-10 items-center gap-3 px-4 py-1.5 transition-colors any-pointer-coarse:min-h-11",
          selected ? "bg-active" : "hover:bg-primary_hover",
        )}
      >
        <span className="hidden size-3.5 shrink-0 sm:flex">{priorityMark("size-3.5")}</span>
        <span className="hidden w-9 shrink-0 text-xs text-tertiary tabular-nums sm:block">
          #{task.number}
        </span>
        <TaskStatusIcon status={task.status} />
        <div className="min-w-0 flex-1 sm:min-w-[12rem]">
          <h3 ref={titleRef} className="text-sm font-medium text-primary [overflow-wrap:anywhere]">
            {renderTitle(<span className="line-clamp-2 sm:line-clamp-1">{task.title}</span>)}
          </h3>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-tertiary tabular-nums sm:hidden">
            {priorityMark("size-3 shrink-0")}
            {channel ? (
              <TaskLocator task={{ number: task.number, channel }} shrink />
            ) : (
              <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                <span className="shrink-0">#{task.number}</span>
                {source && <span className="truncate">{source}</span>}
              </span>
            )}
            {task.dueAt && (
              <span className="ms-auto shrink-0">
                <TaskDueAt task={task} hydrated={hydrated} timeZone={timeZone} />
              </span>
            )}
          </p>
        </div>
        {blocked && <span className="hidden shrink-0 lg:inline-flex">{blocked}</span>}
        {(parent || subtasks) && (
          <span className="hidden shrink-0 items-center gap-2 text-xs text-tertiary xl:inline-flex">
            {parent}
            {subtasks}
          </span>
        )}
        {source && (
          <Pill className="hidden min-w-10 shrink sm:inline-flex">
            {channel ? <ChannelPlace name={channel} /> : <span className="truncate">{source}</span>}
          </Pill>
        )}
        {task.labels?.length ? (
          <span className="hidden min-w-0 shrink md:inline-flex">
            <TaskCardLabels labels={task.labels} />
          </span>
        ) : null}
        {project && (
          <ProjectPill project={project} className="hidden min-w-12 shrink lg:inline-flex" />
        )}
        {task.dueAt && (
          <span className="hidden shrink-0 sm:inline-flex">
            <TaskDueAt task={task} hydrated={hydrated} timeZone={timeZone} />
          </span>
        )}
        <TaskOwnerAvatar owner={task.owner} tooltip={reached} />
        {tools}
      </article>
    );
  }
  const waitingOn = openBlockers(task.blockedBy).find((blocker) => !blocker.hidden);
  const steps = task.subtasks;
  const [label, ...moreLabels] = task.labels ?? [];
  return (
    <article
      ref={cardRef}
      data-selected={selected ? "true" : undefined}
      aria-current={selected ? "true" : undefined}
      onClickCapture={rememberCard}
      onPointerEnter={onPointerEnter}
      onFocusCapture={onReach}
      className={cn(
        "group relative flex flex-col gap-2.5 rounded-lg border bg-primary p-3 transition-colors",
        selected
          ? "border-brand bg-active ring-1 ring-brand ring-inset"
          : "border-secondary hover:border-primary",
      )}
    >
      <div className="flex h-5 items-center gap-1.5 text-xs tabular-nums">
        {source && (
          <span className="flex min-w-0 font-medium text-secondary">
            {channel ? <ChannelPlace name={channel} /> : <span className="truncate">{source}</span>}
          </span>
        )}
        <span className="shrink-0 text-quaternary">#{task.number}</span>
        {priorityMark("ms-auto size-3.5 text-fg-quaternary")}
      </div>
      <h3 ref={titleRef} className="text-sm font-medium text-primary [overflow-wrap:anywhere]">
        {renderTitle(<span className="line-clamp-2">{task.title}</span>)}
      </h3>
      {waitingOn ? (
        <p className="-mt-1 flex min-w-0 items-start gap-1.5 text-xs text-warning-primary">
          <span
            aria-hidden="true"
            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-warning-secondary"
          />
          <span className="min-w-0 line-clamp-2 wrap-anywhere">
            {m.task_board_waiting({ number: waitingOn.number, title: waitingOn.title })}
          </span>
        </p>
      ) : (
        blocked
      )}
      {(label || project) && (
        <div className="flex min-w-0 items-center gap-1.5">
          {label && <TaskLabelChip label={label} className="min-w-0 shrink" />}
          {moreLabels.length > 0 && (
            <span className="shrink-0 text-xs text-tertiary">+{moreLabels.length}</span>
          )}
          {project && <ProjectPill project={project} className="min-w-12 shrink" />}
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
      <div
        data-task-card-footer
        className={cn(
          "flex min-h-7 items-center justify-between gap-2",
          tools && "any-pointer-coarse:pe-16",
        )}
      >
        <TaskOwnerAvatar owner={task.owner} tooltip={reached} />
        <span className="flex shrink-0 items-center gap-3">
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
          <TaskCreatedAt at={task.createdAt} hydrated={hydrated} timeZone={timeZone} />
          <TaskDueAt task={task} hydrated={hydrated} timeZone={timeZone} />
        </span>
      </div>
      {tools && (
        <div className="absolute top-2 end-1.5 rounded-md bg-primary opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 any-pointer-coarse:top-auto any-pointer-coarse:bottom-2.5 any-pointer-coarse:opacity-100">
          {tools}
        </div>
      )}
    </article>
  );
}
