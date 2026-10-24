import type { PgBoss } from "pg-boss";
import {
  APP_NOTIFICATION_EVENT_QUEUE,
  APP_NOTIFICATION_DELIVERY_QUEUE,
} from "#src/server/app-notifications/app-notification-jobs";

/** The suite owns these workers. Wait for in-flight fan-out before removing only this run's
 * jobs, so deleted fixture Workspaces cannot leave a backlog for the next suite. */
export async function cleanNotificationFixtureJobs(boss: PgBoss, workspaceIds: Iterable<string>) {
  await boss.offWork(APP_NOTIFICATION_EVENT_QUEUE, { wait: true });
  await boss.offWork(APP_NOTIFICATION_DELIVERY_QUEUE, { wait: true });
  for (const workspaceId of workspaceIds) {
    for (const [queue, data] of [
      [APP_NOTIFICATION_EVENT_QUEUE, { workspaceId }],
      [APP_NOTIFICATION_DELIVERY_QUEUE, { event: { workspaceId } }],
    ] as const) {
      const jobs = await boss.findJobs(queue, { data });
      if (jobs.length)
        await boss.deleteJob(
          queue,
          jobs.map((job) => job.id),
        );
    }
  }
}
