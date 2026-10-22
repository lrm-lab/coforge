import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import {
  APP_NOTIFICATION_DELIVERY_QUEUE,
  APP_NOTIFICATION_EVENT_QUEUE,
  appNotificationDeliveryJobId,
} from "#src/server/app-notifications/app-notification-jobs";
import {
  APP_NOTIFICATION_POLLING_INTERVAL_SECONDS,
  startAppNotificationQueue,
  stopAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { AppNotifications } from "#src/server/app-notifications/app-notifications.server";
import { createAppRegistry } from "#src/server/apps/app-registry-composition.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { fanOutAppNotificationEvents } from "#src/server/app-notifications/event-worker.server";
import { admitWorkspaceMember } from "#src/server/workspaces/member-admission.server";

/**
 * The app notification outbox against local PostgreSQL with migrations applied: an event is a
 * pg-boss job written in the caller's transaction (so it exists iff that transaction commits), the
 * event worker fans it out to the installations of its Workspace while `app-notifications` is on
 * for that Workspace, and admitting a member records `workspace.member_added`.
 *
 * Skipped unless `APP_NOTIFICATIONS_TEST_DATABASE_URL` points at local PostgreSQL. It also needs
 * `DATABASE_URL` to name the same database, which the queue starts on.
 */
const connectionString = Bun.env.APP_NOTIFICATIONS_TEST_DATABASE_URL;
const db = connectionString
  ? new PrismaClient({ adapter: new PrismaPg({ connectionString }) })
  : undefined;

const RUN = crypto.randomUUID().slice(0, 8);
const ON_SLUGS = Array.from({ length: 16 }, (_, index) => `notify-on-${RUN}-${index}`);
let nextOnSlug = 0;
let flagDirectory: string | undefined;
let boss: Awaited<ReturnType<typeof startAppNotificationQueue>>;

beforeAll(async () => {
  if (!db || !connectionString) return;
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-notifications-"));
  const path = join(flagDirectory, "flags.json");
  await Bun.write(
    path,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      flags: {
        "app-notifications": {
          state: "ENABLED",
          variants: { on: true, off: false },
          defaultVariant: "off",
          targeting: { if: [{ in: [{ var: "workspaceSlug" }, ON_SLUGS] }, "on", "off"] },
        },
      },
    }),
  );
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: path }),
  );
  boss = await startAppNotificationQueue(connectionString);
});

afterAll(async () => {
  await stopAppNotificationQueue();
  await installFeatureFlags({ status: "disabled" });
  if (flagDirectory) await rm(flagDirectory, { recursive: true, force: true });
  await db?.$disconnect();
});

/** A Workspace with an owner and one app registered (hence installed) in it; the flag is on for
 * it unless `flag` is `off`. */
async function fixture(db: PrismaClient, { flag = "on" }: { flag?: "on" | "off" } = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db.user.create({
    data: { displayName: `notify-${suffix}`, username: `notify-${suffix}` },
  });
  const workspace = await db.workspace.create({
    data: {
      slug: flag === "on" ? ON_SLUGS[nextOnSlug++]! : `notify-off-${suffix}`,
      name: "Notifications",
      members: { create: [{ userId: owner.id, role: "owner" }] },
    },
  });
  const key = `notify-${suffix}`;
  await createAppRegistry(db).registerApp(
    { workspaceId: workspace.id, actorUserId: owner.id },
    {
      key,
      name: "Acme Notified",
      description: "",
      whenToUse: "",
      homepageUrl: null,
      redirectUris: [],
      category: "other",
      allowedScopes: ["openid", "profile", "identity"],
    },
  );
  const installation = await db.appInstallation.findFirstOrThrow({
    where: { workspaceId: workspace.id },
    select: { id: true },
  });
  return {
    workspace,
    owner,
    installationId: installation.id,
    async cleanup() {
      await db.workspace.delete({ where: { id: workspace.id } }).catch(() => {});
      await db.user.deleteMany({ where: { id: owner.id } }).catch(() => {});
    },
  };
}

/** A `workspace.member_added` event for a made-up member. */
function memberAdded(workspaceId: string) {
  return newAppNotificationEvent({
    type: "workspace.member_added",
    workspaceId,
    data: { userId: crypto.randomUUID(), role: "member" },
  });
}

async function eventJobs(workspaceId: string) {
  return boss.findJobs(APP_NOTIFICATION_EVENT_QUEUE, { data: { workspaceId } });
}

/** The worker polls, so the longest wait for it is a few polling intervals. */
const WORKER_DEADLINE_MS = APP_NOTIFICATION_POLLING_INTERVAL_SECONDS * 1_000 * 5;
const WORKER_POLL_MS = 100;

/** Resolves once `check` holds, or fails the test at the deadline: the worker polls the queue, so
 * the only observable completion is the job's own state. */
async function until<Result>(check: () => Promise<Result | undefined>, what: string) {
  const deadline = Date.now() + WORKER_DEADLINE_MS;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(WORKER_POLL_MS);
  }
}

async function processed(workspaceId: string) {
  return until(async () => {
    const [job] = await eventJobs(workspaceId);
    return job?.state === "completed" ? job : undefined;
  }, "the event worker to complete the event job");
}

// Above the `until` deadline, which is what ends a worker wait.
const WORKER_TEST_TIMEOUT_MS = WORKER_DEADLINE_MS + 5_000;
const testWithDatabase = db ? test : test.skip;

testWithDatabase("an event recorded in a committed transaction becomes an event job", async () => {
  const { workspace, cleanup } = await fixture(db!);
  try {
    const event = memberAdded(workspace.id);
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    await db!.$transaction((tx) => AppNotifications.record(tx, workspace, event));
    const [job] = await eventJobs(workspace.id);
    expect(job?.id).toBe(event.id);
    expect(job?.data).toEqual(event);
  } finally {
    await cleanup();
  }
});

testWithDatabase("an event recorded in a rolled-back transaction leaves no job", async () => {
  const { workspace, cleanup } = await fixture(db!);
  try {
    const event = memberAdded(workspace.id);
    await expect(
      db!.$transaction(async (tx) => {
        await AppNotifications.record(tx, workspace, event);
        throw new Error("domain write failed");
      }),
    ).rejects.toThrow("domain write failed");
    expect(await eventJobs(workspace.id)).toEqual([]);
  } finally {
    await cleanup();
  }
});

testWithDatabase("recording the same event twice leaves one job", async () => {
  const { workspace, cleanup } = await fixture(db!);
  try {
    const event = memberAdded(workspace.id);
    await db!.$transaction((tx) => AppNotifications.record(tx, workspace, event));
    await db!.$transaction((tx) => AppNotifications.record(tx, workspace, event));
    expect(await eventJobs(workspace.id)).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

testWithDatabase(
  "the event worker enqueues one delivery per installation of that Workspace, only while the flag is on",
  async () => {
    const on = await fixture(db!);
    const other = await fixture(db!);
    const off = await fixture(db!, { flag: "off" });
    try {
      const record = async (workspace: { id: string; slug: string }) => {
        const event = memberAdded(workspace.id);
        await db!.$transaction((tx) => AppNotifications.record(tx, workspace, event));
        return event;
      };
      const offEvent = await record(off.workspace);
      const onEvent = await record(on.workspace);
      expect(await eventJobs(off.workspace.id)).toEqual([]);
      await processed(on.workspace.id);

      const deliveries = await boss.findJobs(APP_NOTIFICATION_DELIVERY_QUEUE, {
        data: { eventId: onEvent.id },
      });
      expect(deliveries.map((job) => job.id)).toEqual([
        appNotificationDeliveryJobId(onEvent.id, on.installationId),
      ]);
      expect(deliveries[0]?.data).toEqual({
        eventId: onEvent.id,
        installationId: on.installationId,
        event: onEvent,
      });
      // The flag-off Workspace's event produced nothing, and neither did the other Workspace's
      // installation get one for an event that is not its own.
      expect(
        await boss.findJobs(APP_NOTIFICATION_DELIVERY_QUEUE, { data: { eventId: offEvent.id } }),
      ).toEqual([]);
      expect(
        await boss.findJobs(APP_NOTIFICATION_DELIVERY_QUEUE, {
          data: { installationId: other.installationId },
        }),
      ).toEqual([]);
    } finally {
      await Promise.all([on.cleanup(), other.cleanup(), off.cleanup()]);
    }
  },
  WORKER_TEST_TIMEOUT_MS,
);

testWithDatabase("admitting a member records workspace.member_added", async () => {
  const { workspace, cleanup } = await fixture(db!);
  const joiner = await db!.user.create({
    data: { displayName: `joiner-${RUN}`, username: `joiner-${crypto.randomUUID().slice(0, 8)}` },
  });
  try {
    await db!.$transaction((tx) =>
      admitWorkspaceMember(tx, { workspace, userId: joiner.id, role: "member" }),
    );
    const [job] = await eventJobs(workspace.id);
    expect(job?.data).toMatchObject({
      type: "workspace.member_added",
      workspaceId: workspace.id,
      data: { userId: joiner.id, role: "member" },
    });

    // The same admission rolled back records nothing.
    const other = await fixture(db!);
    try {
      await expect(
        db!.$transaction(async (tx) => {
          await admitWorkspaceMember(tx, {
            workspace: other.workspace,
            userId: joiner.id,
            role: "member",
          });
          throw new Error("rolled back");
        }),
      ).rejects.toThrow("rolled back");
      expect(await eventJobs(other.workspace.id)).toEqual([]);
    } finally {
      await other.cleanup();
    }
  } finally {
    await cleanup();
    await db!.user.deleteMany({ where: { id: joiner.id } }).catch(() => {});
  }
});

testWithDatabase(
  "running the event worker twice for one event leaves one delivery per installation",
  async () => {
    const { workspace, owner, installationId, cleanup } = await fixture(db!);
    try {
      await createAppRegistry(db!).registerApp(
        { workspaceId: workspace.id, actorUserId: owner.id },
        {
          key: `notify-second-${crypto.randomUUID().slice(0, 8)}`,
          name: "Second",
          description: "",
          whenToUse: "",
          homepageUrl: null,
          redirectUris: [],
          category: "other",
          allowedScopes: ["openid", "profile", "identity"],
        },
      );
      const event = memberAdded(workspace.id);
      const jobs = [{ data: event }] as Parameters<typeof fanOutAppNotificationEvents>[1];
      await fanOutAppNotificationEvents(boss, jobs);
      await fanOutAppNotificationEvents(boss, jobs);
      const deliveries = await boss.findJobs(APP_NOTIFICATION_DELIVERY_QUEUE, {
        data: { eventId: event.id },
      });
      expect(deliveries).toHaveLength(2);
      expect(new Set(deliveries.map((job) => job.id)).size).toBe(2);
      expect(deliveries.map((job) => job.id)).toContain(
        appNotificationDeliveryJobId(event.id, installationId),
      );
    } finally {
      await cleanup();
    }
  },
);
