import { fromPrisma } from "pg-boss";

import type { Prisma } from "#src/generated/prisma/client";
import type { AppNotificationEvent } from "./app-notification-event";
import { APP_NOTIFICATION_EVENT_QUEUE } from "./app-notification-jobs";
import { startedAppNotificationQueue } from "./app-notification-queue.server";
import { appNotificationsEnabled } from "./subscribers.server";

/**
 * The only way domain code emits an app notification. `record` writes the event as a job in the
 * caller's transaction: the event exists if and only if that transaction commits. Recording an
 * event again by its id changes nothing. Delivery to the apps happens later, from the queue.
 * `workspace` is the caller's own Workspace identity, so recording reads nothing but the flag.
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
};

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
