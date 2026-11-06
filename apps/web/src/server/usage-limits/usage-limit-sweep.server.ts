import type { PrismaClient } from "#src/generated/prisma/client";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { UsageLimitChangedEvent } from "#src/features/usage-limits/usage-limit-events";
import { createCentrifugoServerApi } from "#src/server/centrifugo/server-api.server";
import { getDatabaseClient } from "#src/server/db/client.server";
import { errorType } from "#src/server/errors/error-type.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import { PrismaUsageLimitEventRepository } from "#src/server/db/repositories/usage-limit-events.repositories.server";
import type { UsageLimitEventChange } from "#src/server/db/repositories/usage-limit-events.repositories.server";
import type { UsageLimitAnnouncer } from "./usage-limit-events.server";
import { createUsageLimitAnnouncer } from "./usage-limit-publisher.server";

/** How often `sweepUsageLimitEvents` looks for events ready to close (task #611). */
export const USAGE_LIMIT_SWEEP_INTERVAL_MS = 5 * 60_000;
/** A defensive bound: an event open this long closes as `aged_out` whatever happened. */
export const USAGE_LIMIT_EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function toChange(event: UsageLimitEventChange): UsageLimitChangedEvent {
  return {
    type: REALTIME_EVENTS.usageLimitChanged,
    workspaceId: event.workspaceId,
    eventId: event.id,
    status: event.status,
    ...(event.closeReason ? { closeReason: event.closeReason } : {}),
    affectedCount: event.affectedCount,
    resetsAt: event.resetsAt?.toISOString() ?? null,
  };
}

/**
 * One sweep pass (task #611): closes open events whose reported reset time
 * passed or whose age passed the defensive bound, drops affected Agents that
 * were deleted or stopped (`agents_gone`), and drops Agents that show
 * provider-work Activity or sent a Message (`recovered`) — closing
 * each event a removal empties. Every close is conditional on the event
 * still being open, so overlapping passes announce once.
 */
export async function sweepUsageLimitEvents(
  db: PrismaClient,
  announce: UsageLimitAnnouncer,
  now: Date = new Date(),
): Promise<void> {
  const repo = new PrismaUsageLimitEventRepository(db);
  const changes = [
    ...(await repo.closeResetPassed(now)),
    ...(await repo.closeAgedOut(new Date(now.getTime() - USAGE_LIMIT_EVENT_MAX_AGE_MS))),
    ...(await repo.removeGoneAgents()),
    ...(await repo.removeRecoveredAgents()),
  ];
  if (changes.length > 0) await announce(changes.map(toChange));
}

let timer: ReturnType<typeof setInterval> | undefined;
let ticking = false;

/** Idempotent per process; only the real-traffic composition calls it. */
export function ensureUsageLimitSweep(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), USAGE_LIMIT_SWEEP_INTERVAL_MS);
  onServerShutdown(() => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}

/** Never rejects: it runs off a `setInterval` with no caller to observe one. */
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const db = getDatabaseClient();
    if (!db) return;
    await sweepUsageLimitEvents(db, createUsageLimitAnnouncer(createCentrifugoServerApi(), db));
  } catch (error) {
    console.error(
      JSON.stringify({ event: "usage_limit_sweep.tick_failed", error_type: errorType(error) }),
    );
  } finally {
    ticking = false;
  }
}
