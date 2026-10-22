import type { TaskHistoryEvent, TaskStatus } from "@lrm/coforge-sdk/internal";
import { getRouteApi } from "@tanstack/react-router";
import { ArrowRight } from "@untitledui/icons";

import { Badge } from "#src/components/base/badges/badges";
import { formatDateForDisplay } from "#src/lib/dates";
import { useTimeFormat } from "#src/lib/time-format-context";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { getLocale } from "#src/paraglide/runtime";
import { taskTimeline } from "./task-history-timeline";
import { statusLabel, TASK_STATUS_COLOR } from "./task-workflow";

const appRoute = getRouteApi("/w/$workspaceSlug");

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge type="color" size="sm" color={TASK_STATUS_COLOR[status].badge}>
      {statusLabel(status)}
    </Badge>
  );
}

export type TimelineNames = {
  actor: (type: TaskHistoryEvent["actorType"], handle: string | null) => string;
  assignee: (kind: "user" | "agent", id: string) => string;
};

/** The Task popup's change history: its read failing, empty, or the timeline of events. */
export function TaskHistory({
  failed,
  events,
  names,
}: {
  failed: boolean;
  events?: readonly TaskHistoryEvent[];
  names: TimelineNames;
}) {
  if (failed)
    return (
      <p role="alert" className="mt-3 text-sm text-error-primary">
        {m.tasks_history_error()}
      </p>
    );
  if (!events) return null;
  if (events.length === 0)
    return <p className="mt-3 text-sm text-tertiary">{m.tasks_history_empty()}</p>;
  return <TaskTimeline events={events} names={names} />;
}

function TaskTimeline({
  events,
  names,
}: {
  events: readonly TaskHistoryEvent[];
  names: TimelineNames;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const timeFormat = useTimeFormat();
  const locale = getLocale();
  return (
    <ol className="mt-3 flex flex-col">
      {taskTimeline(events).map(({ event, status, lineStatus }, index) => (
        <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
          {index < events.length - 1 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-4 bottom-0 left-1.5 w-px -translate-x-1/2",
                lineStatus ? TASK_STATUS_COLOR[lineStatus].line : "bg-border-secondary",
              )}
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-1 size-3 shrink-0 rounded-full",
              status ? TASK_STATUS_COLOR[status].dot : "border-2 border-primary bg-primary",
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="text-sm font-semibold text-primary">{eventTitle(event)}</div>
            <div className="text-xs text-tertiary">
              {names.actor(event.actorType, event.actorName)} ·{" "}
              {formatDateForDisplay(event.createdAt, timeZone, locale, timeFormat)}
            </div>
            <EventDetail event={event} names={names} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function eventTitle(event: TaskHistoryEvent) {
  switch (event.eventType) {
    case "created":
      return m.tasks_history_created();
    case "status_changed":
      return m.tasks_history_status_changed();
    case "assignee_changed":
      return m.tasks_history_assignee_changed();
    case "amended":
      return m.tasks_history_amended();
  }
}

function EventDetail({ event, names }: { event: TaskHistoryEvent; names: TimelineNames }) {
  const detail = "mt-1 text-sm text-secondary";
  switch (event.eventType) {
    case "created":
      return (
        <p className={detail}>
          {m.tasks_history_created_detail({
            number: String(event.payload.taskNumber),
            status: statusLabel(event.payload.status),
          })}
        </p>
      );
    case "status_changed":
      return (
        <div className="mt-1 flex items-center gap-1.5">
          <StatusBadge status={event.payload.from} />
          <ArrowRight aria-hidden="true" className="size-3.5 text-fg-quaternary" />
          <StatusBadge status={event.payload.to} />
        </div>
      );
    case "assignee_changed": {
      const { assigneeId, assigneeType } = event.payload;
      return (
        <p className={detail}>
          {assigneeId && assigneeType
            ? m.tasks_history_assigned_to({ name: names.assignee(assigneeType, assigneeId) })
            : m.tasks_history_unassigned()}
        </p>
      );
    }
    case "amended": {
      const { title, description } = event.payload.changes;
      const empty = "—";
      return (
        <>
          {title && (
            <p className={cn(detail, "break-words")}>
              {m.tasks_history_field_change({
                field: m.tasks_title(),
                from: title.from,
                to: title.to,
              })}
            </p>
          )}
          {description && (
            <p className={cn(detail, "line-clamp-3 break-words")}>
              {m.tasks_history_field_change({
                field: m.tasks_description(),
                from: description.from ?? empty,
                to: description.to ?? empty,
              })}
            </p>
          )}
        </>
      );
    }
  }
}
