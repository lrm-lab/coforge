import { PgBoss } from "pg-boss";

import { AppError } from "#src/lib/app-error";
import { configuredDatabaseUrl, getDatabaseClient } from "#src/server/db/client.server";
import { databasePoolConfig } from "#src/server/db/pool-config.server";
import { PrismaAppNotificationQueueSchema } from "#src/server/db/repositories/app-notification-queue-schema.repositories.server";
import type { DatabaseScope } from "#src/server/db/transaction.server";
import {
  isFeatureDefined,
  onFeatureFlagsChanged,
} from "#src/server/feature-flags/feature-flags.server";
import { onServerShutdown } from "#src/server/runtime/server-lifecycle.server";
import type { AppNotificationEvent } from "./app-notification-event";
import {
  deliverAppNotifications,
  deliverExternalInboxNotices,
  fanOutAppNotificationEvents,
} from "./event-worker.server";
import {
  EXTERNAL_INBOX_NOTICE_QUEUE,
  EXTERNAL_INBOX_NOTICE_QUEUE_OPTIONS,
  type ExternalInboxNoticeJob,
} from "#src/server/agents/external-inbox-notice-queue.server";
import { resumeExternalPushProbes } from "#src/server/agents/external-inbox-notice-delivery-composition.server";
import {
  artifactCheckConfig,
  artifactChecksEnabled,
} from "#src/server/artifacts/artifact-check-config.server";
import {
  ARTIFACT_VERSION_CHECK_QUEUE,
  ARTIFACT_VERSION_CHECK_QUEUE_OPTIONS,
  registerArtifactCheckQueueAccessor,
  type ArtifactVersionCheckJob,
} from "#src/server/artifacts/artifact-check-queue.server";
import { productionArtifactChecks } from "#src/server/artifacts/artifact-composition.server";
import { anyExternalPushWebhook } from "#src/server/db/repositories/external-agent-push-webhook.repositories.server";
import {
  APP_NOTIFICATION_DELIVERY_QUEUE,
  APP_NOTIFICATION_EVENT_QUEUE,
  DELIVERY_QUEUE_OPTIONS,
  type AppNotificationDeliveryJob,
} from "./app-notification-jobs";

/** pg-boss's own pool: enough for its workers and its maintenance, apart from Prisma's. */
const QUEUE_POOL_SIZE = 4;

/** How often an idle worker asks its queue for work. Recording wakes nobody, so this is the
 * latency from an event to its fan-out, and from a delivery job to its attempt. */
export const APP_NOTIFICATION_POLLING_INTERVAL_SECONDS = 2;

/** Event jobs only read the database and insert delivery jobs, so a failure is a database
 * outage: retry for a few hours of backoff before giving the job up (seconds). */
const EVENT_QUEUE_OPTIONS = {
  retryLimit: 8,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 3_600,
};

/** After a failed start, wait this long before trying again, doubling up to the cap, for at most
 * this many retries (about ten minutes in all); then only a flag file reload or a restart tries. */
export const QUEUE_START_RETRY = { initialDelayMs: 1_000, maxDelayMs: 30_000, maxRetries: 24 };

/** The start in flight or finished, and the queue itself once that start has settled
 * successfully. `running` is what `record` may use: it is never set while pg-boss is still
 * starting, so no domain transaction can wait on (or race) pg-boss's schema DDL. */
let starting: Promise<PgBoss> | undefined;
let running: PgBoss | undefined;
/** Set when the server is told to stop; after that nothing starts the queue. */
let stopping = false;
let shutdownRegistered = false;
const stopListeningForStarts = new Set<() => void>();

/**
 * Starts pg-boss once per process, with the two workers, on `connectionString` (the server's
 * `DATABASE_URL` by default). pg-boss installs and migrates its own `pgboss` schema when it starts,
 * so the database user needs `CREATE` on the database for the first start, and it must never run
 * inside a domain transaction: only server start and a flag file reload start it. A failed start is
 * not remembered; the next call tries again.
 */
export function startAppNotificationQueue(
  connectionString: string | undefined = configuredDatabaseUrl(),
): Promise<PgBoss> {
  if (!connectionString || stopping) return Promise.reject(new AppError("TEMPORARILY_UNAVAILABLE"));
  const url = connectionString;
  registerShutdown();
  starting ??= (async () => {
    const boss = new PgBoss({
      ...databasePoolConfig(url),
      max: QUEUE_POOL_SIZE,
      application_name: "coforge-app-notifications",
    });
    boss.on("error", () =>
      console.error(JSON.stringify({ event: "app_notifications:queue_error" })),
    );
    try {
      await boss.start();
      await boss.createQueue(APP_NOTIFICATION_EVENT_QUEUE, EVENT_QUEUE_OPTIONS);
      await boss.createQueue(APP_NOTIFICATION_DELIVERY_QUEUE, DELIVERY_QUEUE_OPTIONS);
      await boss.createQueue(EXTERNAL_INBOX_NOTICE_QUEUE, EXTERNAL_INBOX_NOTICE_QUEUE_OPTIONS);
      await boss.createQueue(ARTIFACT_VERSION_CHECK_QUEUE, ARTIFACT_VERSION_CHECK_QUEUE_OPTIONS);
      const polling = { pollingIntervalSeconds: APP_NOTIFICATION_POLLING_INTERVAL_SECONDS };
      await boss.work<AppNotificationEvent>(APP_NOTIFICATION_EVENT_QUEUE, polling, (jobs) =>
        fanOutAppNotificationEvents(boss, jobs),
      );
      await boss.work<AppNotificationDeliveryJob>(
        APP_NOTIFICATION_DELIVERY_QUEUE,
        polling,
        deliverAppNotifications,
      );
      await boss.work<ExternalInboxNoticeJob>(EXTERNAL_INBOX_NOTICE_QUEUE, polling, (jobs) =>
        deliverExternalInboxNotices(boss, jobs),
      );
      const checkConfig = artifactCheckConfig();
      if (checkConfig) {
        await boss.work<ArtifactVersionCheckJob>(
          ARTIFACT_VERSION_CHECK_QUEUE,
          {
            pollingIntervalSeconds: APP_NOTIFICATION_POLLING_INTERVAL_SECONDS,
            localConcurrency: checkConfig.concurrency,
          },
          async (jobs) => {
            const db = getDatabaseClient();
            if (!db) throw new Error("Database client unavailable for artifact publish check");
            const checks = productionArtifactChecks(db);
            for (const job of jobs) {
              const retriesDone = (job as { retryCount?: number }).retryCount ?? 0;
              await checks.runJob(job.data, {
                retryable: retriesDone < ARTIFACT_VERSION_CHECK_QUEUE_OPTIONS.retryLimit,
              });
            }
          },
        );
      }
      await resumeExternalPushProbes(boss).catch(() =>
        console.error(JSON.stringify({ event: "app_notifications:probe_resume_failed" })),
      );
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => {});
      throw error;
    }
    running = boss;
    registerArtifactCheckQueueAccessor(startedAppNotificationQueue);
    return boss;
  })().catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}

/** Waits for the running handlers to finish, then closes pg-boss's pool. */
export async function stopAppNotificationQueue(): Promise<void> {
  const pending = starting;
  starting = undefined;
  running = undefined;
  if (pending) await (await pending.catch(() => undefined))?.stop({ graceful: true });
}

/**
 * The queue, only if its start has settled successfully; otherwise nothing. It never waits for a
 * start in flight and never starts one.
 */
export function startedAppNotificationQueue(): PgBoss | undefined {
  return running;
}

registerArtifactCheckQueueAccessor(startedAppNotificationQueue);

/** Whether the queue is running in this process. */
export function isAppNotificationQueueStarted(): boolean {
  return running !== undefined;
}

/** The one shutdown hook: stop listening for flag reloads and retrying first, forbid any later
 * start, then stop the queue. Registered once, however many times the queue starts. */
export async function shutdownAppNotifications(): Promise<void> {
  stopping = true;
  for (const stopListening of stopListeningForStarts) stopListening();
  stopListeningForStarts.clear();
  await stopAppNotificationQueue();
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  onServerShutdown(shutdownAppNotifications);
}

export async function startAppNotificationQueueIfNeeded(
  db: DatabaseScope,
  connectionString: string,
): Promise<boolean> {
  if (running) return true;
  const needed =
    isFeatureDefined("app-notifications") ||
    artifactChecksEnabled() ||
    (await new PrismaAppNotificationQueueSchema(db).exists()) ||
    (await anyExternalPushWebhook(db));
  if (!needed) return false;
  await startAppNotificationQueue(connectionString);
  return true;
}

/**
 * Starts the queue where it is needed now, and again whenever a reloaded flag file makes it needed.
 * A failed start is logged and retried with backoff (`QUEUE_START_RETRY`), so a database that was
 * not ready yet does not leave recording skipped until a restart. Returns the function that
 * stops listening and retrying; the shutdown hook calls it too.
 */
export function startAppNotificationQueueAtServerStart(
  db: DatabaseScope,
  connectionString: string,
  retry: typeof QUEUE_START_RETRY = QUEUE_START_RETRY,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  let active = true;
  const attempt = async () => {
    timer = undefined;
    if (!active || stopping) return;
    try {
      await startAppNotificationQueueIfNeeded(db, connectionString);
      retries = 0;
    } catch {
      console.error(JSON.stringify({ event: "app_notifications:queue_start_failed" }));
      if (retries >= retry.maxRetries) return;
      const delay = Math.min(retry.maxDelayMs, retry.initialDelayMs * 2 ** retries++);
      timer = setTimeout(() => void attempt(), delay);
      timer.unref();
    }
  };
  const stopListening = onFeatureFlagsChanged(() => {
    if (timer) return;
    retries = 0;
    void attempt();
  });
  const stop = () => {
    active = false;
    clearTimeout(timer);
    stopListening();
    stopListeningForStarts.delete(stop);
  };
  stopListeningForStarts.add(stop);
  registerShutdown();
  void attempt();
  return stop;
}

/** The server start call, made by the SSR entry on the first request: needs a database. */
export function startAppNotificationQueueAtServerStartFromEnv(): void {
  const db = getDatabaseClient();
  const url = configuredDatabaseUrl();
  if (!db || !url) return;
  startAppNotificationQueueAtServerStart(db, url);
}
