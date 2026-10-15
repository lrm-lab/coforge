import { expect, test } from "bun:test";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";

function fakeRedis() {
  const values = new Map<string, string>();
  return {
    values,
    redis: {
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
      get: async (key: string) => values.get(key) ?? null,
    },
  };
}

test("a Computer supports a capability while its daemon last said so, and keeps it alive", async () => {
  const { redis, values } = fakeRedis();
  const migration = new RedisComputerCapabilityLease(
    redis,
    "agent-migration:v1",
    "agent-migration-capability",
  );
  const reminder = new RedisComputerCapabilityLease(redis, "reminder:v1", "reminder-capability");
  await migration.record("w", "new-computer", ["reminder:v1", "agent-migration:v1"]);
  await reminder.record("w", "new-computer", ["reminder:v1", "agent-migration:v1"]);
  await migration.record("w", "old-computer", ["reminder:v1"]);
  expect(await migration.supports("w", "new-computer")).toBe(true);
  expect(await reminder.supports("w", "new-computer")).toBe(true);
  expect(await migration.supports("w", "old-computer")).toBe(false);
  expect(await migration.supports("w", "never-seen")).toBe(false);
  // A heartbeat keeps a supported capability; it never turns an unsupported one into support.
  values.clear();
  await migration.refresh("w", "new-computer");
  expect(await migration.supports("w", "new-computer")).toBe(false);
});
