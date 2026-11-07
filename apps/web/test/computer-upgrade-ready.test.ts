import { expect, test } from "bun:test";
import { RedisComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { computerUpgradeRedis as memoryRedis } from "./support/computer-upgrade-redis";

const identity = (workerInstanceId: string, version: string, startedAt: number) => ({
  workerInstanceId,
  computerVersion: version,
  daemonVersion: version,
  startedAt,
});

test("upgrade completion requires concrete version, fresh worker, and matching versions", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(
    scope,
    { workerInstanceId: "old", computerVersion: "1.0.0", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );
  await store.begin(scope, "request", "2.0.0");
  // A ready that cannot prove the new version leaves the in-flight request accepted.
  await store.ready(
    scope,
    { workerInstanceId: "new", computerVersion: "1.0.0", daemonVersion: "1.0.0", startedAt: 2 },
    ["other"],
  );
  expect((await store.status(scope, "request"))?.status).toBe("accepted");
  // The proving ready completes it even though the daemon recovered no request ids.
  await store.ready(
    scope,
    { workerInstanceId: "new", computerVersion: "2.0.0", daemonVersion: "2.0.0", startedAt: 3 },
    [],
  );
  expect(await store.status(scope, "request")).toMatchObject({
    status: "completed",
    expectedVersion: "2.0.0",
  });
});

test("mismatched ready versions fail closed instead of completing", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(
    scope,
    { workerInstanceId: "old", computerVersion: "1.0.0", daemonVersion: "1.0.0", startedAt: 1 },
    [],
  );
  await store.begin(scope, "request", "2.0.0");
  await store.ready(
    scope,
    { workerInstanceId: "new", computerVersion: "2.0.0", daemonVersion: "1.9.0", startedAt: 2 },
    ["request"],
  );
  expect((await store.status(scope, "request"))?.status).toBe("failed");
});

test("ready settles every accepted request on the Computer, not only the recovered ones", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  const prefix = "coforge:workspace:w:computer:c:upgrade:v1";
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "first", "2.0.0");
  // A second accepted record whose terminal report never arrived (the daemon lost it across the
  // upgrade restart). begin() cannot create it now, so it is seeded the way a pre-existing or
  // otherwise untracked record would look: a request record plus its inflight membership.
  redis.values.set(
    `${prefix}:request:second`,
    JSON.stringify({
      requestId: "second",
      status: "accepted",
      expectedVersion: "2.0.0",
      expiresAt: new Date(1000 + 600_000).toISOString(),
      previousWorkerInstanceId: "old",
    }),
  );
  redis.sets.set(`${prefix}:inflight`, new Set(["first", "second"]));

  await store.ready(scope, identity("new", "2.0.0", 2), []);

  expect(await store.status(scope, "first")).toMatchObject({ status: "completed" });
  expect(await store.status(scope, "second")).toMatchObject({ status: "completed" });
});

test("ready compares each request's own expected version before completing it", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  const prefix = "coforge:workspace:w:computer:c:upgrade:v1";
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  // Two accepted requests wanting different versions: only the one the new identity proves
  // completes; the other stays accepted for its own report or a later proving ready.
  await store.begin(scope, "wanted-2", "2.0.0");
  redis.values.set(
    `${prefix}:request:wanted-3`,
    JSON.stringify({
      requestId: "wanted-3",
      status: "accepted",
      expectedVersion: "3.0.0",
      expiresAt: new Date(1000 + 600_000).toISOString(),
      previousWorkerInstanceId: "old",
    }),
  );
  redis.sets.set(`${prefix}:inflight`, new Set(["wanted-2", "wanted-3"]));

  await store.ready(scope, identity("new", "2.0.0", 2), []);

  expect(await store.status(scope, "wanted-2")).toMatchObject({ status: "completed" });
  expect(await store.status(scope, "wanted-3")).toMatchObject({
    status: "accepted",
    expectedVersion: "3.0.0",
  });
  // Still inflight: a later ready proving 3.0.0 settles it then.
  expect(redis.sets.get(`${prefix}:inflight`)).toEqual(new Set(["wanted-3"]));
});
