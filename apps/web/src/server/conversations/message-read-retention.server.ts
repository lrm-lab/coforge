import type { PrismaClient } from "#src/generated/prisma/client";
import { getDatabaseClient } from "#src/server/db/client.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";

/**
 * Keeps `message_reads` from growing forever: a direct message's read record is only the "read
 * at" time its sender sees, and a message older than the retention window shows no time at all
 * (its "read" check comes from `ConversationMember.readThroughSequence`, not this table). The
 * daily sweep deletes the rows past the window in batches, under row locks only, so it never
 * blocks a reader or a writer; deleting the same rows twice is harmless, so every instance may
 * run it.
 */

/** How long a read record is kept: seven days, as Frank asked on 2026-11-03. */
export const MESSAGE_READ_RETENTION_MS = 7 * 86_400_000;
/** Rows one statement deletes, so no single delete holds a long lock. */
export const MESSAGE_READ_RETENTION_BATCH = 2_000;
/** Statements one tick runs at most (200k rows at the default batch); the rest waits a day. */
export const MESSAGE_READ_RETENTION_BATCHES = 100;
/** The sweep's period: once a day, on every instance. */
export const MESSAGE_READ_RETENTION_TICK_MS = 24 * 60 * 60 * 1_000;

/** The oldest `readAt` a read record may have at `now`. */
export function messageReadCutoff(now: Date): Date {
  return new Date(now.getTime() - MESSAGE_READ_RETENTION_MS);
}

/**
 * Deletes the read records older than the retention window, one batch at a time, and returns how
 * many rows it deleted. `FOR UPDATE SKIP LOCKED` lets two instances split the work instead of
 * blocking on each other, and no `ORDER BY` keeps each statement a short scan of the oldest pages
 * (a sort would read the whole table before the `LIMIT`); the rows are written in `readAt` order.
 */
export async function deleteExpiredMessageReads(
  db: Pick<PrismaClient, "$executeRaw">,
  now: Date = new Date(),
  options: { batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  const batchSize = options.batchSize ?? MESSAGE_READ_RETENTION_BATCH;
  const maxBatches = options.maxBatches ?? MESSAGE_READ_RETENTION_BATCHES;
  const cutoff = messageReadCutoff(now);
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const count = await db.$executeRaw`
      DELETE FROM "message_reads"
      WHERE "id" IN (
        SELECT "id" FROM "message_reads"
        WHERE "readAt" < ${cutoff}
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )`;
    deleted += count;
    if (count < batchSize) break;
  }
  return deleted;
}

/** Boot hook: a non-overlapping in-process tick, safe to run in every instance. */
export function startMessageReadRetentionTick(deps: {
  db: () => PrismaClient | undefined;
  intervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  log?: (event: Record<string, unknown>) => void;
}): { stop: () => void } {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const log = deps.log ?? ((event) => console.info(JSON.stringify(event)));
  let inFlight = false;
  const tick = () => {
    if (inFlight) return;
    inFlight = true;
    const db = deps.db();
    if (!db) {
      inFlight = false;
      return;
    }
    void deleteExpiredMessageReads(db)
      .then((deleted) => log({ event: "message_read_retention_tick", deleted }))
      .catch((error: unknown) =>
        log({
          event: "message_read_retention_tick_failed",
          error: error instanceof Error ? error.name : typeof error,
        }),
      )
      .finally(() => {
        inFlight = false;
      });
  };
  const handle = setIntervalFn(tick, deps.intervalMs ?? MESSAGE_READ_RETENTION_TICK_MS);
  // A daily interval alone would never fire on a process that restarts more often than that.
  tick();
  return { stop: () => clearInterval(handle) };
}

/** Boot hook: starts the sweep on the app's database client and stops it on shutdown. */
export function startMessageReadRetentionTickFromEnv(): { stop: () => void } {
  const tick = startMessageReadRetentionTick({ db: getDatabaseClient });
  onServerShutdown(tick.stop);
  return tick;
}
