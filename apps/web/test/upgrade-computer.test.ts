import { expect, test } from "bun:test";
import { decodeComputerUpgradeIntent } from "@lrm/coforge-sdk/internal";

import {
  UpgradeComputer,
  type CloudImageUpgrade,
} from "#src/server/computers/upgrade-computer.server";
import { RedisComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";
import { computerUpgradeRedis as memoryRedis } from "./support/computer-upgrade-redis";

const identity = (workerInstanceId: string, version: string, startedAt: number) => ({
  workerInstanceId,
  computerVersion: version,
  daemonVersion: version,
  startedAt,
});

function upgradeComputer(overrides: {
  upgrades: RedisComputerUpgradeStore;
  online?: boolean;
  subscribed?: boolean;
  latestVersion?: () => Promise<string>;
  publish?: (channel: string, data: Uint8Array) => Promise<void>;
  cloud?: CloudImageUpgrade;
}) {
  const publications: Array<{ channel: string; data: Uint8Array }> = [];
  const upgrade = new UpgradeComputer(
    overrides.upgrades,
    { get: async () => overrides.online ?? true },
    overrides.latestVersion ?? (async () => "2.0.0"),
    {
      publish: async (channel, data) => {
        publications.push({ channel, data });
        await overrides.publish?.(channel, data);
      },
    },
    async () => (overrides.online ?? true) && (overrides.subscribed ?? true),
    overrides.cloud,
  );
  return { upgrade, publications };
}

test("a present Computer's upgrade request is registered and its intent published", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  const { upgrade, publications } = upgradeComputer({ upgrades: store, online: true });

  const status = await upgrade.execute(
    { workspaceId: "workspace-1" },
    { computerId: "computer-1", requestId: "upgrade-1" },
  );

  expect(status).toMatchObject({ requestId: "upgrade-1", status: "accepted" });
  expect(publications).toHaveLength(1);
  expect(publications[0]?.channel).toBe("daemon:workspace-1:computer-1");
  expect(decodeComputerUpgradeIntent(publications[0]!.data)).toMatchObject({
    requestId: "upgrade-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    expectedVersion: "2.0.0",
  });
});

test("a Computer that is not present rejects a new request without registering or publishing anything", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  const { upgrade, publications } = upgradeComputer({ upgrades: store, online: false });

  await expect(
    upgrade.execute(
      { workspaceId: "workspace-1" },
      { computerId: "computer-1", requestId: "upgrade-1" },
    ),
  ).rejects.toMatchObject({ name: "AppError", code: "COMPUTER_OFFLINE" });
  expect(publications).toEqual([]);
  await expect(store.status(scope, "upgrade-1")).resolves.toBeUndefined();
});

test("an existing requestId is answered from the stored status even while presence reads false", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  const first = upgradeComputer({ upgrades: store, online: true });
  const accepted = await first.upgrade.execute(
    { workspaceId: "workspace-1" },
    { computerId: "computer-1", requestId: "upgrade-1" },
  );
  expect(accepted).toMatchObject({ status: "accepted" });

  // The Computer may be mid-restart as part of the very upgrade it is polling, so a retry with
  // the same requestId must not be refused merely because presence currently reads false.
  const retry = upgradeComputer({ upgrades: store, online: false });
  const status = await retry.upgrade.execute(
    { workspaceId: "workspace-1" },
    { computerId: "computer-1", requestId: "upgrade-1" },
  );

  expect(status).toEqual(accepted);
  expect(retry.publications).toEqual([]);
});

test("a present Computer with no identity on record fails with COMPUTER_IDENTITY_UNKNOWN, not offline", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const { upgrade, publications } = upgradeComputer({ upgrades: store, online: true });

  await expect(
    upgrade.execute(
      { workspaceId: "workspace-1" },
      { computerId: "computer-1", requestId: "upgrade-1" },
    ),
  ).rejects.toMatchObject({ name: "AppError", code: "COMPUTER_IDENTITY_UNKNOWN" });
  expect(publications).toEqual([]);
});

test("a cloud computer image replace is queued on the host and never published to the daemon", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "0.1.2-dev.attach", 1), []);
  const queued: Array<{ computerId: string; imageId: string }> = [];
  const { upgrade, publications } = upgradeComputer({
    upgrades: store,
    online: true,
    cloud: {
      available: async () => ({ imageId: "sha256:new", version: "0.1.3-dev.2" }),
      enqueue: async (input) => {
        queued.push({ computerId: input.computerId, imageId: input.imageId });
      },
    },
  });

  const status = await upgrade.execute(
    { workspaceId: "workspace-1", userId: "user-a" },
    { computerId: "computer-1", requestId: "upgrade-1", placement: "cloud" },
  );

  expect(status).toMatchObject({
    requestId: "upgrade-1",
    status: "accepted",
    expectedVersion: "0.1.3-dev.2",
    target: "image",
  });
  expect(queued).toEqual([{ computerId: "computer-1", imageId: "sha256:new" }]);
  expect(publications).toEqual([]);
});

test("a cloud runtime upgrade is queued on the host and does not replace the image", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "0.1.2-dev.attach", 1), []);
  const queued: string[] = [];
  const { upgrade, publications } = upgradeComputer({
    upgrades: store,
    online: true,
    latestVersion: async () => "0.1.3-dev.4",
    cloud: {
      available: async () => ({ imageId: "sha256:new", version: "node-2" }),
      enqueue: async () => {
        throw new Error("image replace");
      },
      enqueueRuntime: async (input) => {
        queued.push(input.version);
      },
    },
  });

  const status = await upgrade.execute(
    { workspaceId: "workspace-1", userId: "user-a" },
    {
      computerId: "computer-1",
      requestId: "upgrade-runtime",
      placement: "cloud",
      target: "runtime",
    },
  );

  expect(status).toMatchObject({
    requestId: "upgrade-runtime",
    status: "accepted",
    expectedVersion: "0.1.3-dev.4",
    target: "runtime",
  });
  expect(queued).toEqual(["0.1.3-dev.4"]);
  expect(publications).toEqual([]);
});

test("a cloud image replace completes once the host reports the offered image layer", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis(), Date.now, async () => "sha256:new");
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "0.1.8-dev.2", 1), []);
  const { upgrade } = upgradeComputer({
    upgrades: store,
    online: true,
    cloud: {
      available: async () => ({ imageId: "sha256:new", version: "0.1.8-dev.2" }),
      enqueue: async () => {},
    },
  });
  await upgrade.execute(
    { workspaceId: "workspace-1", userId: "user-a" },
    { computerId: "computer-1", requestId: "upgrade-1", placement: "cloud" },
  );
  expect(await store.status(scope, "upgrade-1")).toMatchObject({
    status: "completed",
    expectedVersion: "0.1.8-dev.2",
    computerVersion: "0.1.8-dev.2",
  });
});

test("a cloud image replace that already swapped does not time out waiting for a version string", async () => {
  let now = 1000;
  const store = new RedisComputerUpgradeStore(
    memoryRedis(),
    () => now,
    async () => "sha256:new",
  );
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "0.1.7-dev.3", 1), []);
  await store.begin(scope, "upgrade-1", "0.1.8-dev.2", {
    completeOnIdentity: true,
    expectedImageId: "sha256:new",
  });
  now += 10 * 60 * 1000;
  expect(await store.status(scope, "upgrade-1")).toMatchObject({
    status: "completed",
    expectedVersion: "0.1.8-dev.2",
  });
});

test("polling a cloud image replace completes after the computer returns on the expected version", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "0.1.2-dev.attach", 1), []);
  const { upgrade } = upgradeComputer({
    upgrades: store,
    online: true,
    cloud: {
      available: async () => ({ imageId: "sha256:new", version: "0.1.3-dev.2" }),
      enqueue: async () => {},
    },
  });
  await upgrade.execute(
    { workspaceId: "workspace-1", userId: "user-a" },
    { computerId: "computer-1", requestId: "upgrade-1", placement: "cloud" },
  );
  await store.ready(scope, identity("new", "0.1.3-dev.2", 2), []);
  expect(await store.status(scope, "upgrade-1")).toMatchObject({
    status: "completed",
    computerVersion: "0.1.3-dev.2",
  });
});

test("a cloud computer without a newer node image is refused without publishing", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "0.1.3-dev.2", 1), []);
  const { upgrade, publications } = upgradeComputer({
    upgrades: store,
    online: true,
    cloud: {
      available: async () => undefined,
      enqueue: async () => {
        throw new Error("unexpected enqueue");
      },
    },
  });
  await expect(
    upgrade.execute(
      { workspaceId: "workspace-1", userId: "user-a" },
      { computerId: "computer-1", requestId: "upgrade-1", placement: "cloud" },
    ),
  ).rejects.toMatchObject({ name: "AppError", code: "CONFLICT" });
  expect(publications).toEqual([]);
});

test("a local upgrade for a Computer nobody is listening on is refused before a record exists", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  const { upgrade, publications } = upgradeComputer({
    upgrades: store,
    online: true,
    subscribed: false,
  });

  await expect(
    upgrade.execute(
      { workspaceId: "workspace-1" },
      { computerId: "computer-1", requestId: "upgrade-1" },
    ),
  ).rejects.toMatchObject({ name: "AppError", code: "COMPUTER_OFFLINE" });
  expect(publications).toEqual([]);
  await expect(store.status(scope, "upgrade-1")).resolves.toBeUndefined();
});

test("a cloud upgrade is still queued while nobody is subscribed to the daemon channel", async () => {
  const queued: string[] = [];
  const cloud: CloudImageUpgrade = {
    available: async () => ({ imageId: "sha256:new", version: "0.1.3-dev.2" }),
    enqueue: async () => {
      queued.push("image");
    },
    enqueueRuntime: async () => {
      queued.push("runtime");
    },
  };
  // One active upgrade per Computer, so each placement gets its own scope and store.
  for (const [computerId, requestId, target] of [
    ["computer-image", "upgrade-image", undefined],
    ["computer-runtime", "upgrade-runtime", "runtime"],
  ] as const) {
    const store = new RedisComputerUpgradeStore(memoryRedis());
    const scope = { workspaceId: "workspace-1", computerId };
    await store.ready(scope, identity("old", "0.1.2-dev.attach", 1), []);
    const { upgrade, publications } = upgradeComputer({
      upgrades: store,
      online: true,
      subscribed: false,
      cloud,
    });

    // The cloud host's queue is durable: an empty daemon channel must not refuse it.
    const status = await upgrade.execute(
      { workspaceId: "workspace-1", userId: "user-a" },
      { computerId, requestId, placement: "cloud", ...(target ? { target } : {}) },
    );
    expect(status).toMatchObject({ status: "accepted" });
    expect(publications).toEqual([]);
  }
  expect(queued).toEqual(["image", "runtime"]);
});

test("a publication failure marks the request failed and still propagates the error", async () => {
  const store = new RedisComputerUpgradeStore(memoryRedis());
  const scope = { workspaceId: "workspace-1", computerId: "computer-1" };
  await store.ready(scope, identity("old", "1.0.0", 1), []);
  const { upgrade } = upgradeComputer({
    upgrades: store,
    online: true,
    publish: async () => {
      throw new Error("centrifugo unavailable");
    },
  });

  await expect(
    upgrade.execute(
      { workspaceId: "workspace-1" },
      { computerId: "computer-1", requestId: "upgrade-1" },
    ),
  ).rejects.toThrow("centrifugo unavailable");

  expect(await store.status(scope, "upgrade-1")).toMatchObject({
    status: "failed",
    reason: "publication",
  });
});
