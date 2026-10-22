import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RedisClient } from "bun";

import { openRedisClient } from "#src/server/redis-client.server";

// Bun's RedisClient gives up for good after `maxRetries` (default 20) failed reconnects and then
// answers every command "Connection has failed", even once Redis is back. `openRedisClient` raises
// the limit, so a client survives an outage of any length. Runs against a Redis container it stops
// and restarts itself (Docker required, like the Centrifugo integration tests).

const REDIS_IMAGE = "redis:8.2.6";
/** Longer than the default 20 retries last (about 22 s measured on Bun 1.4.3). */
const OUTAGE_MS = 35_000;
const RECOVERY_DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 500;
/** A command queued while Redis is down may wait; the test only needs to know it did not answer. */
const PING_TIMEOUT_MS = 2_000;
const SETUP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = OUTAGE_MS + RECOVERY_DEADLINE_MS + SETUP_TIMEOUT_MS;

let containerName: string;
let client: RedisClient;

function docker(...args: string[]) {
  const result = Bun.spawnSync(["docker", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function ping() {
  const answered = client.send("PING", []).then(
    () => true,
    () => false,
  );
  return Promise.race([answered, Bun.sleep(PING_TIMEOUT_MS).then(() => false)]);
}

beforeAll(async () => {
  containerName = `coforge-redis-reconnect-${crypto.randomUUID()}`;
  // A fixed host port: an ephemeral published port changes when the container restarts.
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  docker(
    "run",
    "--detach",
    "--name",
    containerName,
    "--publish",
    `127.0.0.1:${port}:6379`,
    REDIS_IMAGE,
  );
  client = openRedisClient(`redis://127.0.0.1:${port}`);
  const deadline = Date.now() + SETUP_TIMEOUT_MS / 2;
  while (!(await ping())) {
    if (Date.now() > deadline) throw new Error("Redis did not become reachable");
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}, SETUP_TIMEOUT_MS);

afterAll(() => {
  client?.close();
  if (containerName) Bun.spawnSync(["docker", "rm", "--force", containerName]);
});

test(
  "a client keeps working after Redis is down longer than the default retry budget",
  async () => {
    docker("stop", containerName);
    const outageEnds = Date.now() + OUTAGE_MS;
    while (Date.now() < outageEnds) {
      expect(await ping()).toBe(false);
      await Bun.sleep(POLL_INTERVAL_MS);
    }
    docker("start", containerName);

    const deadline = Date.now() + RECOVERY_DEADLINE_MS;
    let recovered = false;
    while (!recovered && Date.now() < deadline) {
      recovered = await ping();
      if (!recovered) await Bun.sleep(POLL_INTERVAL_MS);
    }
    expect(recovered).toBe(true);
  },
  TEST_TIMEOUT_MS,
);
