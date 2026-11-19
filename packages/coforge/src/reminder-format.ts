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

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  const cached = formatters.get(zone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(zone, created);
  return created;
}

function localTime(iso: string, zone: string): string | undefined {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  try {
    const parts = formatter(zone).formatToParts(at);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
  } catch {
    return undefined;
  }
}

export function formatReminderTime(iso: string, ...zones: readonly (string | undefined)[]): string {
  for (const zone of zones) {
    if (!zone) continue;
    const local = localTime(iso, zone);
    if (local) return `${local} ${zone} (${iso})`;
  }
  return `${iso} (UTC; account time zone unknown)`;
}

export function formatReminderRow(
  reminder: ReminderSummaryRecord,
  now: number = Date.now(),
  shortId: string = shortReminderId(reminder.reminderId, []),
  displayTimezone?: string,
): string {
  const cadence = reminder.repeat
    ? `recurring · ${reminder.repeat}${reminder.timezone ? ` (${reminder.timezone})` : ""}`
    : "one-time";
  const overdue =
    reminder.status === "scheduled" && Date.parse(reminder.fireAt) < now ? " [OVERDUE]" : "";
  return `#${shortId} [${reminder.status}] (${cadence}) next=${formatReminderTime(reminder.fireAt, reminder.timezone, displayTimezone)}${overdue} ${JSON.stringify(foldUntrustedLine(reminder.title))}`;
}

function formatLogEvent(event: ReminderLogEvent, displayTimezone?: string): string {
  return `event=${event.eventId} type=${event.type} time=${event.time} next=${event.nextFireAt ? formatReminderTime(event.nextFireAt, displayTimezone) : "-"}`;
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
        formatReminderRow(
          reminder,
          Date.now(),
          shortReminderId(reminder.reminderId, ids),
          result.displayTimezone,
        ),
      )
      .join("\n");
  }
  if (operation === "log") {
    if (!result.events.length) return "No reminder events found.";
    return result.events.map((event) => formatLogEvent(event, result.displayTimezone)).join("\n");
  }
  const reminder = result.reminders[0];
  return reminder
    ? formatReminderRow(reminder, Date.now(), undefined, result.displayTimezone)
    : `Accepted reminder ${operation} request.`;
}
