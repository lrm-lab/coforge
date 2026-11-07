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
  // A ready that cannot prove the new version leaves the in-flight request accepted: the same
  // worker instance re-readying says nothing about whether its installer still runs.
  await store.ready(
    scope,
    { workerInstanceId: "old", computerVersion: "1.0.0", daemonVersion: "1.0.0", startedAt: 2 },
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

test("a proven new identity on another version fails an unclaimed request with the actual version", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "request", "2.0.0");

  // The Computer came back on a new instance running a different version, and its daemon does
  // not know the request: the installer is gone and can never report, so the request fails now
  // with the version the Computer actually runs instead of spinning to its deadline.
  await store.ready(scope, identity("new", "1.5.0", 2), []);

  expect(await store.status(scope, "request")).toMatchObject({
    status: "failed",
    reason: "version-mismatch",
    actualVersion: "1.5.0",
  });
});

test("an unproven or claimed request is not failed by another version's ready", async () => {
  const scope = { workspaceId: "w", computerId: "c" };
  const prefix = "coforge:workspace:w:computer:c:upgrade:v1";
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  await store.begin(scope, "same-worker", "2.0.0");
  // begin() admits one request at a time, so seed the second the way a pre-existing record
  // looks: its own request record plus inflight membership.
  redis.values.set(
    `${prefix}:request:claimed`,
    JSON.stringify({
      requestId: "claimed",
      status: "accepted",
      expectedVersion: "2.0.0",
      expiresAt: new Date(1000 + 600_000).toISOString(),
      previousWorkerInstanceId: "old",
    }),
  );
  redis.sets.set(`${prefix}:inflight`, new Set(["same-worker", "claimed"]));

  // Same worker instance re-readying on another version proves nothing about the installer:
  // it may still be running, so the request stays accepted.
  await store.ready(
    scope,
    { workerInstanceId: "old", computerVersion: "1.5.0", daemonVersion: "1.5.0", startedAt: 2 },
    [],
  );
  expect(await store.status(scope, "same-worker")).toMatchObject({ status: "accepted" });

  // A daemon that claims the request but cannot prove it fails closed as evidence, not as a
  // version mismatch.
  await store.ready(scope, identity("new", "1.5.0", 3), ["claimed"]);
  expect(await store.status(scope, "claimed")).toMatchObject({
    status: "failed",
    reason: "evidence",
  });
});

test("ready compares each request's own expected version before completing it", async () => {
  const redis = memoryRedis();
  const store = new RedisComputerUpgradeStore(redis, () => 1000);
  const scope = { workspaceId: "w", computerId: "c" };
  const prefix = "coforge:workspace:w:computer:c:upgrade:v1";
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  // Two accepted requests wanting different versions: only the one the new identity proves
  // completes; the other fails at once - the Computer runs another version and its daemon
  // never claimed the request, so its installer is gone and cannot report.
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
    status: "failed",
    reason: "version-mismatch",
    actualVersion: "2.0.0",
  });
  expect(redis.sets.get(`${prefix}:inflight`)).toEqual(new Set());
});
