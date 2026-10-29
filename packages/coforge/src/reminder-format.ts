import type {
  AgentReminderOperationResponse,
  ReminderLogEvent,
  ReminderSummaryRecord,
} from "@lrm/coforge-sdk/internal";

/** The eight-hex prefix `message read` shows, as the reminder commands name a reminder. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * One reminder as a line, as the reference client prints it:
 * `#id8 [status] (one-time|recurring · rule) next=<iso> [OVERDUE] "title"`.
 * `[OVERDUE]` marks a scheduled reminder whose fire time has passed.
 */
export function formatReminderRow(
  reminder: ReminderSummaryRecord,
  now: number = Date.now(),
): string {
  const cadence = reminder.repeat ? `recurring · ${reminder.repeat}` : "one-time";
  const overdue =
    reminder.status === "scheduled" && Date.parse(reminder.fireAt) < now ? " [OVERDUE]" : "";
  return `#${shortId(reminder.reminderId)} [${reminder.status}] (${cadence}) next=${reminder.fireAt}${overdue} ${JSON.stringify(reminder.title)}`;
}

function formatLogEvent(event: ReminderLogEvent): string {
  return `event=${event.eventId} type=${event.type} time=${event.time} next=${event.nextFireAt ?? "-"}`;
}

/**
 * What a reminder command prints for the server's answer. The server returns the reminder a
 * schedule, update, snooze or cancel produced, so those name it instead of saying "Accepted".
 */
export function formatReminderResponse(
  operation: string,
  result: AgentReminderOperationResponse,
): string {
  if (!result.accepted) return "Reminder request was not accepted.";
  if (operation === "list") {
    if (!result.reminders.length) return "No reminders.";
    return result.reminders.map((reminder) => formatReminderRow(reminder)).join("\n");
  }
  if (operation === "log") {
    if (!result.events.length) return "No reminder events found.";
    return result.events.map(formatLogEvent).join("\n");
  }
  const reminder = result.reminders[0];
  return reminder ? formatReminderRow(reminder) : `Accepted reminder ${operation} request.`;
}
