import { z } from "zod";

import { publicationDataOrUndefined } from "#src/features/realtime/publication-data";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";

/** The four ways an open usage-limit event ends (task #611). */
export const USAGE_LIMIT_CLOSE_REASONS = [
  "reset_passed",
  "recovered",
  "agents_gone",
  "aged_out",
] as const;
export type UsageLimitCloseReason = (typeof USAGE_LIMIT_CLOSE_REASONS)[number];

/**
 * `usage.limit.changed.v1` on a person's `chat:user:<id>` channel: an open
 * event appeared, its affected-Agent set changed, or an open one closed — for
 * a Workspace owner/admin only. `affectedCount`/`resetsAt` describe the
 * event's current state so the client can update without a refetch; the
 * client still rereads the list it is authorized for.
 */
export type UsageLimitChangedEvent = {
  type: typeof REALTIME_EVENTS.usageLimitChanged;
  workspaceId: string;
  eventId: string;
  status: "open" | "closed";
  closeReason?: UsageLimitCloseReason;
  affectedCount: number;
  /** ISO instant, or null when no report named a reset (e.g. billing exhaustion). */
  resetsAt: string | null;
};

const usageLimitChangedEvent = z.object({
  type: z.literal(REALTIME_EVENTS.usageLimitChanged),
  workspaceId: z.string().min(1),
  eventId: z.string().min(1),
  status: z.enum(["open", "closed"]),
  closeReason: z.enum(USAGE_LIMIT_CLOSE_REASONS).optional(),
  affectedCount: z.number().int().nonnegative(),
  resetsAt: z.string().nullable(),
});

export function decodeUsageLimitChangedEvent(input: unknown): UsageLimitChangedEvent | undefined {
  const event = usageLimitChangedEvent.safeParse(publicationDataOrUndefined(input));
  return event.success ? event.data : undefined;
}
