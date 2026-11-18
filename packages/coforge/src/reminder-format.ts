import { foldUntrustedLine } from "@lrm/coforge-sdk/internal";
import type {
  AgentReminderOperationResponse,
  ReminderLogEvent,
  ReminderSummaryRecord,
} from "@lrm/coforge-sdk/internal";

const MIN_SHORT_ID_LENGTH = 8;

function hexId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

export function shortReminderId(id: string, ids: readonly string[]): string {
  const hex = hexId(id);
  const others = ids.filter((other) => other !== id).map(hexId);
  let length = MIN_SHORT_ID_LENGTH;
  while (length < hex.length && others.some((other) => other.startsWith(hex.slice(0, length))))
    length += 1;
  return hex.slice(0, length);
}

export function formatReminderRow(
  reminder: ReminderSummaryRecord,
  now: number = Date.now(),
  shortId: string = shortReminderId(reminder.reminderId, []),
): string {
  const cadence = reminder.repeat
    ? `recurring · ${reminder.repeat}${reminder.timezone ? ` (${reminder.timezone})` : ""}`
    : "one-time";
  const overdue =
    reminder.status === "scheduled" && Date.parse(reminder.fireAt) < now ? " [OVERDUE]" : "";
  return `#${shortId} [${reminder.status}] (${cadence}) next=${reminder.fireAt}${overdue} ${JSON.stringify(foldUntrustedLine(reminder.title))}`;
}

function formatLogEvent(event: ReminderLogEvent): string {
  return `event=${event.eventId} type=${event.type} time=${event.time} next=${event.nextFireAt ?? "-"}`;
}

export function formatReminderResponse(
  operation: string,
  result: AgentReminderOperationResponse,
): string {
  if (!result.accepted) return "Reminder request was not accepted.";
  if (operation === "list") {
    if (!result.reminders.length) return "No reminders.";
    const ids = result.reminders.map((reminder) => reminder.reminderId);
    return result.reminders
      .map((reminder) =>
        formatReminderRow(reminder, Date.now(), shortReminderId(reminder.reminderId, ids)),
      )
      .join("\n");
  }
  if (operation === "log") {
    if (!result.events.length) return "No reminder events found.";
    return result.events.map(formatLogEvent).join("\n");
  }
  const reminder = result.reminders[0];
  return reminder ? formatReminderRow(reminder) : `Accepted reminder ${operation} request.`;
}
