import type { TaskHistoryEvent, TaskLabel, TaskPriority } from "@lrm/coforge-sdk/internal";

import { m } from "#src/paraglide/messages";

/** History events added after the first timeline: labels, priority and Project changes. */
export type LaterHistoryEvent = Extract<
  TaskHistoryEvent,
  { eventType: "labels_changed" | "priority_changed" | "project_changed" }
>;

export function laterEventTitle(event: LaterHistoryEvent) {
  switch (event.eventType) {
    case "labels_changed":
      return m.tasks_history_labels_changed();
    case "priority_changed":
      return m.tasks_history_priority_changed();
    case "project_changed":
      return m.tasks_history_project_changed();
  }
}

export function priorityLabel(priority: TaskPriority) {
  switch (priority) {
    case "urgent":
      return m.tasks_priority_urgent();
    case "high":
      return m.tasks_priority_high();
    case "medium":
      return m.tasks_priority_medium();
    case "low":
      return m.tasks_priority_low();
    case "none":
      return m.tasks_priority_none();
  }
}

const EMPTY_VALUE = "—";
const labelNames = (labels: readonly TaskLabel[]) => labels.map((label) => label.name).join(", ");

export function LaterEventDetail({ event }: { event: LaterHistoryEvent }) {
  const detail = "mt-1 text-sm text-secondary break-words";
  switch (event.eventType) {
    case "labels_changed": {
      const { added, removed } = event.payload;
      return (
        <>
          {added.length > 0 && (
            <p className={detail}>{m.tasks_history_blockers_added({ names: labelNames(added) })}</p>
          )}
          {removed.length > 0 && (
            <p className={detail}>
              {m.tasks_history_blockers_removed({ names: labelNames(removed) })}
            </p>
          )}
        </>
      );
    }
    case "priority_changed":
      return (
        <p className={detail}>
          {m.tasks_history_field_change({
            field: m.tasks_priority(),
            from: priorityLabel(event.payload.from),
            to: priorityLabel(event.payload.to),
          })}
        </p>
      );
    case "project_changed": {
      const { from, to } = event.payload;
      return (
        <p className={detail}>
          {m.tasks_history_field_change({
            field: m.tasks_project(),
            from: from?.name ?? EMPTY_VALUE,
            to: to?.name ?? EMPTY_VALUE,
          })}
        </p>
      );
    }
  }
}
