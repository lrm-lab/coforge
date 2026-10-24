import { expect, test } from "bun:test";
import { PgBoss } from "pg-boss";
import { AppNotifications } from "#src/server/app-notifications/app-notifications.server";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import {
  APP_NOTIFICATION_EVENT_QUEUE,
  APP_NOTIFICATION_DELIVERY_QUEUE,
} from "#src/server/app-notifications/app-notification-jobs";
import { emitterDatabaseUrl, startEmitterEnvironment } from "./helpers/app-notification-emitters";

test("notification fixture teardown removes its queued jobs and preserves another scope", async () => {
  if (!emitterDatabaseUrl) throw new Error("APP_NOTIFICATIONS_TEST_DATABASE_URL is required");
  const env = await startEmitterEnvironment();
  const inspector = new PgBoss({ connectionString: emitterDatabaseUrl, max: 2 });
  const foreignWorkspaceId = crypto.randomUUID();
  let stopped = false;
  let fixture: Awaited<ReturnType<typeof env.fixture>> | undefined;
  const eventFor = (workspaceId: string) =>
    newAppNotificationEvent({
      type: "workspace.member_added",
      workspaceId,
      data: { user_id: crypto.randomUUID(), role: "member" },
    });
  try {
    await inspector.start();
    fixture = await env.fixture();
    const workspaceId = fixture.workspace.id;
    const event = eventFor(workspaceId);
    const foreign = eventFor(foreignWorkspaceId);
    await env.db.$transaction((tx) => AppNotifications.record(tx, fixture!.workspace, event));
    for (const value of [event, foreign]) {
      if (value === foreign) await inspector.send(APP_NOTIFICATION_EVENT_QUEUE, value);
      await inspector.send(APP_NOTIFICATION_DELIVERY_QUEUE, {
        eventId: value.id,
        installationId: crypto.randomUUID(),
        event: value,
      });
    }
    expect(await env.recorded(workspaceId, "workspace.member_added")).toHaveLength(1);
    await fixture.cleanup();
    fixture = undefined;
    await env.stop();
    stopped = true;
    for (const [queue, ownData, foreignData] of [
      [APP_NOTIFICATION_EVENT_QUEUE, { workspaceId }, { workspaceId: foreignWorkspaceId }],
      [
        APP_NOTIFICATION_DELIVERY_QUEUE,
        { event: { workspaceId } },
        { event: { workspaceId: foreignWorkspaceId } },
      ],
    ] as const) {
      expect(await inspector.findJobs(queue, { data: ownData })).toEqual([]);
      const kept = await inspector.findJobs(queue, { data: foreignData });
      expect(kept).toHaveLength(1);
      await inspector.deleteJob(
        queue,
        kept.map((job) => job.id),
      );
    }
  } finally {
    await fixture?.cleanup();
    if (!stopped) await env.stop();
    await inspector.stop({ graceful: true });
  }
});
