import type { TaskHistoryEvent } from "@lrm/coforge-sdk/internal";
import { formatUtcTimestamp } from "./message-format";
import { historyEventHeader } from "./task-history-format";

/** What an event says in the stream; a description change is flagged, its text is not shown. */
function eventBody(event: TaskHistoryEvent): string {
  if (event.eventType !== "amended") return JSON.stringify(event.payload);
  const { title, description } = event.payload.changes;
  return [
    ...(title ? [JSON.stringify({ ...event.payload, changes: { title } })] : []),
    ...(description ? ["updated the description"] : []),
  ].join(" ");
}

/** One history event as a line of a task's merged stream, in the format `task history` prints. */
export function timelineEventLine(event: TaskHistoryEvent): string {
  const header = historyEventHeader(event, formatUtcTimestamp(event.createdAt));
  return `- [event ${header}] ${eventBody(event)}`;
}
