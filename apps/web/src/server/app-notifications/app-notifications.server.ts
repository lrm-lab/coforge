import { fromPrisma, type PgBoss } from "pg-boss";

import type { Prisma } from "#src/generated/prisma/client";
import {
  newAppNotificationEvent,
  type AppNotificationEvent,
  type AppNotificationEventPayload,
} from "./app-notification-event";
import { APP_NOTIFICATION_EVENT_QUEUE } from "./app-notification-jobs";
import { startedAppNotificationQueue } from "./app-notification-queue.server";
import { isFeatureDefined } from "#src/server/feature-flags/feature-flags.server";
import { appNotificationsEnabled } from "./subscribers.server";

/**
 * The only way domain code emits an app notification. `record` writes the event as a job in the
 * caller's transaction: the event exists if and only if that transaction commits. Recording an
 * event again by its id changes nothing. Delivery to the apps happens later, from the queue.
 * `workspace` is the caller's own Workspace identity, so `record` reads nothing but the flag;
 * `recordAppNotifications` is for a caller that has only the Workspace id, and reads its slug first.
 *
 * Notifications are best effort and never affect the operation that emits them: `record` never
 * throws and never aborts the caller's transaction. While `app-notifications` is off for the
 * Workspace it does nothing. While it is on, the queue must already be running (it starts when the
 * server starts, or when the flag file first defines the flag, never inside a domain transaction,
 * because pg-boss creates its schema when it starts; a start still in flight does not count,
 * `record` never waits for it). If it is not, the event is skipped and logged. The send runs in a
 * SAVEPOINT, so a failed send rolls back only to it: the domain transaction goes on and the event
 * is skipped and logged. A send that succeeds is atomic with the domain transaction.
 */
export const AppNotifications = {
  async record(
    tx: Prisma.TransactionClient,
    workspace: { id: string; slug: string },
    event: AppNotificationEvent,
  ): Promise<void> {
    if (!(await appNotificationsEnabled(workspace))) return;
    const boss = startedAppNotificationQueue();
    if (!boss) return skipped("queue_not_started", event);
    try {
      await tx.$executeRaw`SAVEPOINT app_notification_record`;
    } catch {
      return skipped("send_failed", event);
    }
    try {
      await boss.send(APP_NOTIFICATION_EVENT_QUEUE, event, { id: event.id, db: fromPrisma(tx) });
      await tx.$executeRaw`RELEASE SAVEPOINT app_notification_record`;
    } catch {
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT app_notification_record`;
      } catch {
        // The transaction itself is gone; the caller's next statement reports that.
      }
      skipped("send_failed", event);
    }
  },

  /**
   * For an event that no PostgreSQL write makes true (a presence change seen in Redis): the same
   * flag check and the same queue, but the job is sent on the queue's own connection, not in a
   * transaction, so it is best effort twice over: no commit decides it, and a failure of any kind
   * (the flag lookup, a queue that is not running, the send) is logged as `record_skipped` and
   * never thrown. The caller derives `event.id`, so sending the same event again changes nothing.
   * Callers do not await it on a request path.
   */
  async recordDetached(
    workspace: { id: string; slug: string },
    event: AppNotificationEvent,
    deps: {
      enabled: (workspace: { id: string; slug: string }) => Promise<boolean>;
      queue: () => Pick<PgBoss, "send"> | undefined;
    } = { enabled: appNotificationsEnabled, queue: startedAppNotificationQueue },
  ): Promise<void> {
    try {
      if (!(await deps.enabled(workspace))) return;
      const boss = deps.queue();
      if (!boss) return skipped("queue_not_started", event);
      await boss.send(APP_NOTIFICATION_EVENT_QUEUE, event, { id: event.id });
    } catch {
      skipped("send_failed", event);
    }
  },
};

/**
 * Whether anything could be notified at all: the flag file defines `app-notifications` (a lookup
 * of the loaded definitions, no query). Production leaves it undefined, and every emitter returns
 * on this before it reads or writes anything, so a deployment that does not use app notifications
 * pays nothing for them. Domain writes that need a different shape to record an event (an
 * interactive transaction, a read of the previous value) take that shape only while this holds.
 */
export function appNotificationsPossible(): boolean {
  return isFeatureDefined("app-notifications");
}

/**
 * Runs `work`, a query or a few that only an emitter needs, inside a SAVEPOINT of its own: if it
 * fails, the transaction rolls back to the savepoint and goes on, so an emitter's failing query
 * can never abort the domain write around it. Returns what `work` returned, or `undefined` when it
 * failed (or the transaction could not take the savepoint).
 */
export async function attemptAppNotification<Result>(
  tx: Prisma.TransactionClient,
  work: () => Promise<Result>,
): Promise<Result | undefined> {
  try {
    await tx.$executeRaw`SAVEPOINT app_notification_attempt`;
  } catch {
    return undefined;
  }
  try {
    const result = await work();
    await tx.$executeRaw`RELEASE SAVEPOINT app_notification_attempt`;
    return result;
  } catch {
    try {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT app_notification_attempt`;
    } catch {
      // The transaction itself is gone; the caller's next statement reports that.
    }
    return undefined;
  }
}

/**
 * Records `events` for the Workspace `workspace.id` in the caller's transaction, one `record`
 * each, for a domain write that knows the Workspace by id only: the slug (which the flag is
 * evaluated with) is read once, unless the caller passes the one it just wrote. `events` may be a
 * function, for events that need a query of their own (they run only once the flag is on for the
 * Workspace). Nothing happens, and nothing is read, unless `appNotificationsPossible()`; a Workspace
 * the flag is off for is checked before any query when the slug is known. Everything the emitter
 * does besides the domain write, building the events included, runs in a savepoint, so as with
 * `record` it never throws and never aborts the transaction.
 */
export async function recordAppNotifications(
  tx: Prisma.TransactionClient,
  workspace: { id: string; slug?: string },
  events:
    | readonly AppNotificationEventPayload[]
    | (() => Promise<readonly AppNotificationEventPayload[]>),
): Promise<void> {
  if (!appNotificationsPossible() || (Array.isArray(events) && events.length === 0)) return;
  if (workspace.slug !== undefined && !(await enabledFor(workspace.id, workspace.slug))) return;
  await attemptAppNotification(tx, async () => {
    const known =
      workspace.slug === undefined
        ? await tx.workspace.findUnique({
            where: { id: workspace.id },
            select: { id: true, slug: true },
          })
        : { id: workspace.id, slug: workspace.slug };
    if (!known) return;
    if (workspace.slug === undefined && !(await enabledFor(known.id, known.slug))) return;
    const list = typeof events === "function" ? await events() : events;
    for (const event of list)
      await AppNotifications.record(
        tx,
        known,
        newAppNotificationEvent({ ...event, workspaceId: known.id }),
      );
  });
}

async function enabledFor(id: string, slug: string): Promise<boolean> {
  try {
    return await appNotificationsEnabled({ id, slug });
  } catch {
    return false;
  }
}

/** Logs that an event was not recorded; ids only, no personal data. */
function skipped(reason: "queue_not_started" | "send_failed", event: AppNotificationEvent): void {
  console.warn(
    JSON.stringify({
      event: "app_notifications:record_skipped",
      reason,
      type: event.type,
      workspace_id: event.workspaceId,
      event_id: event.id,
    }),
  );
}
