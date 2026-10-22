import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "#src/generated/prisma/client";
import { APP_NOTIFICATION_EVENT_QUEUE } from "#src/server/app-notifications/app-notification-jobs";
import {
  isAppNotificationQueueStarted,
  startAppNotificationQueue,
  startAppNotificationQueueAtServerStart,
  startAppNotificationQueueIfNeeded,
  startedAppNotificationQueue,
  shutdownAppNotifications,
  stopAppNotificationQueue,
} from "#src/server/app-notifications/app-notification-queue.server";
import { newAppNotificationEvent } from "#src/server/app-notifications/app-notification-event";
import { AppNotifications } from "#src/server/app-notifications/app-notifications.server";
import { PrismaAppNotificationQueueSchema } from "#src/server/db/repositories/app-notification-queue-schema.repositories.server";
import {
  isFeatureDefined,
  onFeatureFlagsChanged,
} from "#src/server/feature-flags/feature-flags.server";
import { readFeatureFlagsConfiguration } from "#src/server/feature-flags/configuration.server";
import { installFeatureFlags } from "#src/server/feature-flags/feature-flags.server";
import { admitWorkspaceMember } from "#src/server/workspaces/member-admission.server";

/**
 * `app-notifications` ships dark: while the flag file does not define the flag nothing starts
 * pg-boss or creates its `pgboss` schema. The queue starts at server start once the flag is defined or the
 * schema exists, and when a reloaded flag file first defines the flag; never inside a domain
 * transaction. A flag-on event with the queue stopped is skipped and logged; it never fails the
 * domain transaction. Needs a database that never saw pg-boss, so it makes its own from the
 * server named by `APP_NOTIFICATIONS_TEST_DATABASE_URL` and migrates it.
 */
const adminUrl = Bun.env.APP_NOTIFICATIONS_TEST_DATABASE_URL;
const databaseName = `app_notifications_dark_${crypto.randomUUID().slice(0, 8)}`;
const url = adminUrl ? withDatabase(adminUrl, databaseName) : "";
let admin: PrismaClient | undefined;
let db: PrismaClient | undefined;
let flagDirectory: string | undefined;
let flagsPath = "";
let stopListening: (() => void) | undefined;
let previousDatabaseUrl: string | undefined;
const ON_SLUGS = [0, 1, 2, 3, 4].map((index) => `dark-on-${databaseName}-${index}`);

/** The flag file, with `app-notifications` defined (on for `ON_SLUGS`) or not. The file always
 * defines another flag, so it is a valid flagd file either way. */
async function writeFlags({
  definesNotifications,
  revision = 0,
}: {
  definesNotifications: boolean;
  revision?: number;
}) {
  const off = { state: "ENABLED", variants: { on: true, off: false }, defaultVariant: "off" };
  await Bun.write(
    flagsPath,
    JSON.stringify({
      $schema: "https://flagd.dev/schema/v0/flags.json",
      metadata: { revision },
      flags: {
        "app-data-permissions": off,
        ...(definesNotifications && {
          "app-notifications": {
            ...off,
            targeting: { if: [{ in: [{ var: "workspaceSlug" }, ON_SLUGS] }, "on", "off"] },
          },
        }),
      },
    }),
  );
}

/** The provider polls the flag file about every five seconds. */
const FLAG_RELOAD_DEADLINE_MS = 30_000;
const FLAG_RELOAD_POLL_MS = 250;

async function untilQueueStarted() {
  const deadline = Date.now() + FLAG_RELOAD_DEADLINE_MS;
  while (!isAppNotificationQueueStarted()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the queue to start");
    await Bun.sleep(FLAG_RELOAD_POLL_MS);
  }
}

/** How long a test watches for something that should (not) have happened. */
const RETRY_OBSERVATION_MS = 1_500;

const schema = () => new PrismaAppNotificationQueueSchema(db!);

function withDatabase(base: string, name: string) {
  const parsed = new URL(base);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

beforeAll(async () => {
  if (!adminUrl) return;
  admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: adminUrl }) });
  await admin.$executeRawUnsafe(`CREATE DATABASE ${databaseName}`);
  const migrate = Bun.spawn([process.execPath, "x", "--bun", "prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdout: "ignore",
    stderr: "pipe",
  });
  if ((await migrate.exited) !== 0) throw new Error(await new Response(migrate.stderr).text());
  db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  flagDirectory = await mkdtemp(join(tmpdir(), "coforge-app-notifications-dark-"));
  flagsPath = join(flagDirectory, "flags.json");
  await writeFlags({ definesNotifications: false });
  await installFeatureFlags(
    await readFeatureFlagsConfiguration({ COFORGE_FEATURE_FLAGS_FILE: flagsPath }),
  );
  previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
}, 120_000);

afterAll(async () => {
  stopListening?.();
  await stopAppNotificationQueue();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await installFeatureFlags({ status: "disabled" });
  if (flagDirectory) await rm(flagDirectory, { recursive: true, force: true });
  await db?.$disconnect();
  await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  await admin?.$disconnect();
});

const testWithDatabase = adminUrl ? test : test.skip;

async function workspaceWith(slug: string) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = await db!.user.create({
    data: { displayName: `dark-${suffix}`, username: `dark-${suffix}` },
  });
  const workspace = await db!.workspace.create({
    data: { slug, name: "Dark", members: { create: [{ userId: owner.id, role: "owner" }] } },
  });
  const joiner = await db!.user.create({
    data: { displayName: `dark-j-${suffix}`, username: `dark-j-${suffix}` },
  });
  return { workspace, joiner };
}

// These run in order: each relies on the state the one before left.
testWithDatabase(
  "while the flag file does not define the flag, admitting a member needs no DATABASE_URL and creates no pgboss schema",
  async () => {
    const { workspace, joiner } = await workspaceWith(`dark-off-${databaseName}`);
    await db!.$transaction((tx) =>
      admitWorkspaceMember(tx, { workspace, userId: joiner.id, role: "member" }),
    );
    expect(await db!.workspaceMembership.count({ where: { userId: joiner.id } })).toBe(1);
    expect(isAppNotificationQueueStarted()).toBe(false);
    expect(await schema().exists()).toBe(false);
  },
);

testWithDatabase(
  "server start leaves a database without the pgboss schema and flag alone",
  async () => {
    expect(await startAppNotificationQueueIfNeeded(db!, url)).toBe(false);
    expect(isAppNotificationQueueStarted()).toBe(false);
    expect(await schema().exists()).toBe(false);
  },
);

testWithDatabase(
  "a reloaded flag file that first defines the flag starts the queue",
  async () => {
    stopListening = startAppNotificationQueueAtServerStart(db!, url);
    await writeFlags({ definesNotifications: true });
    await untilQueueStarted();
    stopListening();
    stopListening = undefined;
    expect(await schema().exists()).toBe(true);
  },
  FLAG_RELOAD_DEADLINE_MS + 30_000,
);

/** Collects the JSON lines `record` logs as `app_notifications:record_skipped`. */
function captureSkipped() {
  const lines: Record<string, unknown>[] = [];
  const spy = spyOn(console, "warn").mockImplementation((line: unknown) => {
    const parsed = JSON.parse(String(line)) as Record<string, unknown>;
    if (parsed.event === "app_notifications:record_skipped") lines.push(parsed);
  });
  return { lines, restore: () => spy.mockRestore() };
}

testWithDatabase(
  "with the flag on and the queue not started, admission succeeds, records no job and logs the skip",
  async () => {
    await stopAppNotificationQueue();
    expect(isAppNotificationQueueStarted()).toBe(false);
    const { workspace, joiner } = await workspaceWith(ON_SLUGS[0]!);
    const captured = captureSkipped();
    try {
      await db!.$transaction((tx) =>
        admitWorkspaceMember(tx, { workspace, userId: joiner.id, role: "member" }),
      );
    } finally {
      captured.restore();
    }
    expect(await db!.workspaceMembership.count({ where: { userId: joiner.id } })).toBe(1);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({
      reason: "queue_not_started",
      type: "workspace.member_added",
      workspace_id: workspace.id,
    });
    expect(typeof captured.lines[0]!.event_id).toBe("string");
    expect(JSON.stringify(captured.lines[0])).not.toContain(joiner.id);
    expect(await schema().exists()).toBe(true);
  },
);

testWithDatabase(
  "a record while the queue's start is in flight is skipped without waiting for the start",
  async () => {
    const { workspace, joiner } = await workspaceWith(ON_SLUGS[1]!);
    const event = newAppNotificationEvent({
      type: "workspace.member_added",
      workspaceId: workspace.id,
      data: { userId: joiner.id, role: "member" },
    });
    const start = startAppNotificationQueue(url);
    // The start has begun but not settled: the queue is not usable, and record must not wait.
    expect(startedAppNotificationQueue()).toBeUndefined();
    const captured = captureSkipped();
    try {
      await db!.$transaction((tx) => AppNotifications.record(tx, workspace, event));
    } finally {
      captured.restore();
    }
    expect(captured.lines).toHaveLength(1);
    expect(startedAppNotificationQueue()).toBeUndefined();
    await start;
    expect(startedAppNotificationQueue()).toBeDefined();
    expect(
      await startedAppNotificationQueue()!.findJobs(APP_NOTIFICATION_EVENT_QUEUE, {
        data: { workspaceId: workspace.id },
      }),
    ).toHaveLength(0);
    await stopAppNotificationQueue();
  },
  FLAG_RELOAD_DEADLINE_MS,
);

testWithDatabase(
  "a start that fails is retried with backoff until it succeeds",
  async () => {
    // The queue's database does not exist yet, so the first start fails; it exists by a retry.
    const lateName = `${databaseName}_late`;
    const lateUrl = withDatabase(adminUrl!, lateName);
    const stop = startAppNotificationQueueAtServerStart(db!, lateUrl, {
      initialDelayMs: 200,
      maxDelayMs: 500,
      maxRetries: 50,
    });
    try {
      await Bun.sleep(RETRY_OBSERVATION_MS);
      expect(isAppNotificationQueueStarted()).toBe(false);
      await admin!.$executeRawUnsafe(`CREATE DATABASE ${lateName}`);
      await untilQueueStarted();
    } finally {
      stop();
      await stopAppNotificationQueue();
      await admin!.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${lateName} WITH (FORCE)`);
    }
  },
  FLAG_RELOAD_DEADLINE_MS,
);

testWithDatabase(
  "server start with the flag defined starts the queue before any event, which is then recorded",
  async () => {
    stopListening = startAppNotificationQueueAtServerStart(db!, url);
    await untilQueueStarted();
    const { workspace: on, joiner: onJoiner } = await workspaceWith(ON_SLUGS[2]!);
    await db!.$transaction((tx) =>
      admitWorkspaceMember(tx, { workspace: on, userId: onJoiner.id, role: "member" }),
    );
    const jobs = await startedAppNotificationQueue()!.findJobs(APP_NOTIFICATION_EVENT_QUEUE, {
      data: { workspaceId: on.id },
    });
    expect(jobs).toHaveLength(1);
  },
  FLAG_RELOAD_DEADLINE_MS + 30_000,
);

testWithDatabase(
  "a send that fails inside the transaction is rolled back to its savepoint: admission commits, no job, skip logged",
  async () => {
    const boss = startedAppNotificationQueue()!;
    const { workspace, joiner } = await workspaceWith(ON_SLUGS[3]!);
    // The send reaches the database and fails there, which aborts a transaction without a savepoint.
    const send = spyOn(boss, "send").mockImplementationOnce((async (...args: unknown[]) => {
      const options = args[2] as { db: { executeSql(text: string): Promise<unknown> } };
      await options.db.executeSql("SELECT 1/0");
    }) as unknown as typeof boss.send);
    const captured = captureSkipped();
    try {
      await db!.$transaction((tx) =>
        admitWorkspaceMember(tx, { workspace, userId: joiner.id, role: "member" }),
      );
    } finally {
      captured.restore();
      send.mockRestore();
    }
    expect(await db!.workspaceMembership.count({ where: { userId: joiner.id } })).toBe(1);
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({ reason: "send_failed", workspace_id: workspace.id });
    expect(
      await boss.findJobs(APP_NOTIFICATION_EVENT_QUEUE, { data: { workspaceId: workspace.id } }),
    ).toHaveLength(0);
  },
);

testWithDatabase(
  "a healthy send stays atomic with the domain transaction: a rolled-back admission leaves no job",
  async () => {
    const boss = startedAppNotificationQueue()!;
    const { workspace, joiner } = await workspaceWith(ON_SLUGS[4]!);
    await expect(
      db!.$transaction(async (tx) => {
        await admitWorkspaceMember(tx, { workspace, userId: joiner.id, role: "member" });
        throw new Error("domain rollback");
      }),
    ).rejects.toThrow("domain rollback");
    expect(await db!.workspaceMembership.count({ where: { userId: joiner.id } })).toBe(0);
    expect(
      await boss.findJobs(APP_NOTIFICATION_EVENT_QUEUE, { data: { workspaceId: workspace.id } }),
    ).toHaveLength(0);
  },
);

testWithDatabase(
  "a flag change after shutdown began does not start the queue",
  async () => {
    await shutdownAppNotifications();
    expect(isAppNotificationQueueStarted()).toBe(false);
    stopListening = undefined;
    // A reload after shutdown that leaves the flag defined: wait until the module has seen it.
    const { promise: reloaded, resolve } = Promise.withResolvers<void>();
    const unlisten = onFeatureFlagsChanged(() => {
      if (isFeatureDefined("app-notifications")) resolve();
    });
    try {
      await writeFlags({ definesNotifications: true, revision: 1 });
      await reloaded;
    } finally {
      unlisten();
    }
    expect(isAppNotificationQueueStarted()).toBe(false);
    await expect(startAppNotificationQueue(url)).rejects.toThrow();
  },
  FLAG_RELOAD_DEADLINE_MS,
);
