import { expect, test } from "bun:test";
import { RedisComputerFileUploadStatuses } from "#src/server/computers/computer-file-upload-statuses.server";

/** What the Redis commands the store sends do to a map, with the expiry it was last given. */
function fakeRedis() {
  const values = new Map<string, { value: string; ttl: number }>();
  const commands: string[][] = [];
  return {
    values,
    commands,
    redis: {
      async set(key: string, value: string, ...options: string[]) {
        commands.push(["SET", key, ...options]);
        values.set(key, { value, ttl: Number(options[1]) });
        return "OK" as const;
      },
      async get(key: string) {
        return values.get(key)?.value ?? null;
      },
      /** `EVAL script 1 key pendingJson ttl`: what the renewal script does, as the test knows it. */
      async send(command: string, args: string[]) {
        commands.push([command, ...args]);
        const [, , key, pending, ttl] = args;
        const entry = values.get(key!);
        if (!entry) values.set(key!, { value: pending!, ttl: Number(ttl) });
        else if (!entry.value.includes('"outcome"')) entry.ttl = Number(ttl);
        return 1;
      },
    },
  };
}

const scope = { workspaceId: "ws-1", computerId: "pc/1" };

test("an upload's record is keyed by Workspace, Computer and upload, and starts as a lease", async () => {
  const { redis, values, commands } = fakeRedis();
  const store = new RedisComputerFileUploadStatuses(redis as never);
  await store.begin(scope, "up-1", "user-1", 30);
  const key = "coforge:workspace:ws-1:computer:pc%2F1:computer-file-upload:v1:up-1";
  expect(commands).toEqual([["SET", key, "EX", "30"]]);
  expect(values.get(key)?.ttl).toBe(30);
  expect(await store.read(scope, "up-1")).toEqual({ userId: "user-1" });
  // Another Workspace or Computer never reaches it.
  expect(await store.read({ ...scope, workspaceId: "ws-2" }, "up-1")).toBeUndefined();
  expect(await store.read({ ...scope, computerId: "pc-2" }, "up-1")).toBeUndefined();
});

test("renewing extends a pending lease", async () => {
  const { redis, values } = fakeRedis();
  const store = new RedisComputerFileUploadStatuses(redis as never);
  await store.begin(scope, "up-1", "user-1", 5);
  await store.renew(scope, "up-1", "user-1", 90);
  const [entry] = [...values.values()];
  expect(entry?.ttl).toBe(90);
  expect(JSON.parse(entry!.value)).toEqual({ userId: "user-1" });
});

test("renewing makes a record that expired pending again, for the same owner", async () => {
  const { redis, values } = fakeRedis();
  const store = new RedisComputerFileUploadStatuses(redis as never);
  await store.renew(scope, "up-1", "user-1", 90);
  expect([...values.values()].map((entry) => entry.ttl)).toEqual([90]);
  expect(await store.read(scope, "up-1")).toEqual({ userId: "user-1" });
});

test("renewing never overwrites or shortens an outcome", async () => {
  const { redis, values } = fakeRedis();
  const store = new RedisComputerFileUploadStatuses(redis as never);
  const outcome = { status: "failed", reason: "timeout" } as const;
  await store.settle(scope, "up-1", "user-1", outcome, 600);
  await store.renew(scope, "up-1", "user-1", 90);
  expect([...values.values()].map((entry) => entry.ttl)).toEqual([600]);
  expect(await store.read(scope, "up-1")).toEqual({ userId: "user-1", outcome });
});

test("settling stores the outcome for the given lifetime", async () => {
  const { redis, values } = fakeRedis();
  const store = new RedisComputerFileUploadStatuses(redis as never);
  await store.begin(scope, "up-1", "user-1", 30);
  const outcome = { status: "failed", reason: "timeout" } as const;
  await store.settle(scope, "up-1", "user-1", outcome, 600);
  expect([...values.values()][0]?.ttl).toBe(600);
  expect(await store.read(scope, "up-1")).toEqual({ userId: "user-1", outcome });
});

test("a record that cannot be parsed reads as missing", async () => {
  const { redis, values } = fakeRedis();
  const store = new RedisComputerFileUploadStatuses(redis as never);
  await store.begin(scope, "up-1", "user-1", 30);
  for (const entry of values.values()) entry.value = "{not json";
  expect(await store.read(scope, "up-1")).toBeUndefined();
});
