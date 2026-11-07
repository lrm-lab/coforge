import type { getUsageLimitEvents } from "./usage-limits.functions";

/** One open usage-limit event as the notifications list reads it (task #641). */
export type UsageLimitNotice = Awaited<ReturnType<typeof getUsageLimitEvents>>[number];

/** The cards to show: a dismissed one stays gone until its event closes. */
export function visibleNotices<T extends Pick<UsageLimitNotice, "viewer">>(events: readonly T[]) {
  return events.filter((event) => event.viewer.dismissedAt === null);
}

/** The ones the viewer has not seen, which the bell counts and the cards mark. */
export function unseenNotices<T extends Pick<UsageLimitNotice, "viewer">>(events: readonly T[]) {
  return visibleNotices(events).filter((event) => event.viewer.seenAt === null);
}

/** `events` with `ids` marked, so a seen or dismissed card changes before its save returns. */
export function markNotices<T extends Pick<UsageLimitNotice, "id" | "viewer">>(
  events: readonly T[],
  ids: readonly string[],
  mark: "seenAt" | "dismissedAt",
  now: Date,
): T[] {
  return events.map((event) =>
    ids.includes(event.id) && event.viewer[mark] === null
      ? { ...event, viewer: { ...event.viewer, [mark]: now } }
      : event,
  );
}
