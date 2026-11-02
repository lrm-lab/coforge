import { expect, test } from "bun:test";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    values,
    redis: {
      async set(key: string, value: string) {
        values.set(key, value);
      },
      async get(key: string) {
        return values.get(key) ?? null;
      },
      async send(_command: "EVAL", args: string[]) {
        const key = args[2]!;
        if (args[0]!.includes("EXPIRE")) return values.get(key) === args[3] ? 1 : 0;
        const candidate = JSON.parse(args[3]!) as {
          workerInstanceId: string;
          startedAt: number;
        };
        const raw = values.get(key);
        if (raw) {
          try {
            const current = JSON.parse(raw) as typeof candidate;
            if (
              current.startedAt > candidate.startedAt ||
              (current.startedAt === candidate.startedAt &&
                current.workerInstanceId !== candidate.workerInstanceId)
            )
              return 0;
          } catch {
            // A legacy scalar is replaced by the first fenced ready.
          }
        }
        values.set(key, args[3]!);
        return 1;
      },
    },
  };
}

const identity = (workerInstanceId: string, startedAt: number) => ({
  workerInstanceId,
  startedAt,
});

test("a Computer supports a capability while its daemon last said so, and keeps it alive", async () => {
  const { redis, values } = fakeRedis();
  const migration = new RedisComputerCapabilityLease(
    redis,
    "agent-migration:v1",
    "agent-migration-capability",
  );
  const reminder = new RedisComputerCapabilityLease(redis, "reminder:v1", "reminder-capability");
  await migration.record(
    "w",
    "new-computer",
    ["reminder:v1", "agent-migration:v1"],
    identity("worker-new", 2),
  );
  await reminder.record(
    "w",
    "new-computer",
    ["reminder:v1", "agent-migration:v1"],
    identity("worker-new", 2),
  );
  await migration.record("w", "old-computer", ["reminder:v1"], identity("worker-old", 1));
  expect(await migration.supports("w", "new-computer")).toBe(true);
  expect(await reminder.supports("w", "new-computer")).toBe(true);
  expect(await migration.supports("w", "old-computer")).toBe(false);
  expect(await migration.supports("w", "never-seen")).toBe(false);
  values.clear();
  await migration.refresh("w", "new-computer");
  expect(await migration.supports("w", "new-computer")).toBe(false);
});

test("a stale worker cannot overwrite a newer worker's capability state", async () => {
  const { redis } = fakeRedis();
  const lease = new RedisComputerCapabilityLease(
    redis,
    "local-session-handoff:v1",
    "local-session-handoff-capability",
  );
  await lease.record("w", "computer", ["local-session-handoff:v1"], identity("new", 2));
  await lease.record("w", "computer", [], identity("old", 1));
  expect(await lease.supports("w", "computer")).toBeTrue();
});

test("a pre-fence supported value stays readable until a ready replaces it", async () => {
  const { redis, values } = fakeRedis();
  const lease = new RedisComputerCapabilityLease(redis, "reminder:v1", "reminder-capability");
  await lease.record("w", "computer", [], identity("worker", 1));
  const key = values.keys().next().value!;
  values.set(key, "supported");
  expect(await lease.supports("w", "computer")).toBeTrue();
  await lease.record("w", "computer", [], identity("worker", 1));
  expect(await lease.supports("w", "computer")).toBeFalse();
});

test("an old heartbeat refresh cannot restore a value replaced by a newer ready", async () => {
  const { redis } = fakeRedis();
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  const send = redis.send.bind(redis);
  redis.send = async (command, args) => {
    if (args[0]!.includes("EXPIRE")) {
      refreshStarted.resolve();
      await releaseRefresh.promise;
    }
    return send(command, args);
  };
  const lease = new RedisComputerCapabilityLease(
    redis,
    "local-session-handoff:v1",
    "local-session-handoff-capability",
  );
  await lease.record("w", "computer", ["local-session-handoff:v1"], identity("old", 1));
  const refreshing = lease.refresh("w", "computer");
  await refreshStarted.promise;
  await lease.record("w", "computer", [], identity("new", 2));
  releaseRefresh.resolve();
  await refreshing;
  expect(await lease.supports("w", "computer")).toBeFalse();
});
