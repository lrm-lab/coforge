import { expect, test } from "bun:test";

import {
  SERVER_SHUTDOWN_BACKSTOP_SLACK_MS,
  SERVER_SHUTDOWN_GRACE_MS,
} from "#src/server/runtime/server-lifecycle.server";
import {
  BUILT_SERVER_BOOT_MS,
  TEST_SLACK_MS,
  reapBuiltServer,
  spawnBuiltServer,
  waitForHealth,
} from "./helpers/built-server";

/**
 * The built Web server's shutdown, against a scratch PostgreSQL with migrations applied and a
 * build in `.output/server` (`mise run build`). SIGTERM must end the process, with status 0: the
 * backstop's non-zero status marks a shutdown that something kept from finishing. The load-bearing
 * handles are real ones: an open database pool (the Workspace Assistant backfill opens a
 * connection at boot), the weekly-report schedule tick's timer and, when `REDIS_URL` is set, the
 * Workspace memory lifecycle's Redis client. Docker sends SIGKILL ten seconds after SIGTERM, so a
 * process that lingers turns every deploy into a forced kill.
 */
const databaseUrl = Bun.env.SERVER_LIFECYCLE_TEST_DATABASE_URL;
const redisUrl = Bun.env.REDIS_URL;
const BOOT_SETTLE_MS = 1_000;
const TIMEOUT_MS =
  BUILT_SERVER_BOOT_MS +
  BOOT_SETTLE_MS +
  SERVER_SHUTDOWN_GRACE_MS +
  SERVER_SHUTDOWN_BACKSTOP_SLACK_MS +
  TEST_SLACK_MS;

async function exitStatusAfter(signals: readonly NodeJS.Signals[], withRedis: boolean) {
  if (!databaseUrl)
    throw new Error("SERVER_LIFECYCLE_TEST_DATABASE_URL must point to local PostgreSQL");
  if (withRedis && !redisUrl) throw new Error("REDIS_URL must point to a local Redis");
  const server = spawnBuiltServer({
    DATABASE_URL: databaseUrl,
    COFORGE_WEEKLY_REPORT_SCHEDULE_TICK_MS: "60000",
    ...(withRedis && redisUrl ? { REDIS_URL: redisUrl } : {}),
  });
  try {
    expect((await waitForHealth(server))?.status).toBe(200);
    // Let the boot-time backfill open its pooled connection.
    await Bun.sleep(BOOT_SETTLE_MS);
    for (const signal of signals) server.process.kill(signal);
    const exited = await Promise.race([
      server.process.exited,
      Bun.sleep(
        SERVER_SHUTDOWN_GRACE_MS + SERVER_SHUTDOWN_BACKSTOP_SLACK_MS + TEST_SLACK_MS / 2,
      ).then(() => "still running"),
    ]);
    return { exited, output: await reapBuiltServer(server) };
  } finally {
    await reapBuiltServer(server);
  }
}

test(
  "SIGTERM stops a server that holds a database pool and a schedule timer",
  async () => {
    const { exited, output } = await exitStatusAfter(["SIGTERM"], false);
    expect(output).not.toContain("server_lifecycle:shutdown_forced");
    expect(exited).toBe(0);
  },
  TIMEOUT_MS,
);

test(
  "SIGTERM then SIGINT stops a server that also holds a Redis client, once",
  async () => {
    if (!redisUrl) return;
    const { exited, output } = await exitStatusAfter(["SIGTERM", "SIGINT"], true);
    expect(output).not.toContain("server_lifecycle:shutdown_forced");
    expect(exited).toBe(0);
  },
  TIMEOUT_MS,
);
