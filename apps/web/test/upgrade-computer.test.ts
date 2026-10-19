import { expect, test } from "bun:test";
import { decodeComputerUpgradeIntent } from "@lrm/coforge-sdk/internal";

import {
  UpgradeComputer,
  type CloudImageUpgrade,
} from "#src/server/computers/upgrade-computer.server";
import { RedisComputerUpgradeStore } from "#src/server/computers/computer-upgrade-store.server";

function memoryRedis() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    mget: async (...keys: string[]) => keys.map((key) => values.get(key) ?? null),
    set: async (...args: string[]) => {
      const [key, value, , , mode] = args;
      if (mode === "NX" && values.has(key!)) return null;
      values.set(key!, value!);
      return "OK";
    },
    send: async (_command: "EVAL", args: string[]) => {
      if (args.length === 4) {
        const [, , key, candidate] = args;
        const current = values.get(key!);
        if (!current || JSON.parse(current).startedAt <= JSON.parse(candidate!).startedAt)
          values.set(key!, candidate!);
        return 1;
      }
      if (args[1] === "2") {
        const [, , requestKey, identityKey, expected, identity, value] = args;
        if (values.get(requestKey!) !== expected) return 0;
        values.set(identityKey!, identity!);
        values.set(requestKey!, value!);
        return 1;
      }
      const [, , key, expected, value] = args;
      if (values.get(key!) !== expected) return 0;
      values.set(key!, value!);
      return 1;
    },
  };
}

const identity = (workerInstanceId: string, version: string, startedAt: number) => ({
  workerInstanceId,
  computerVersion: version,
  daemonVersion: version,
  startedAt,
});

function upgradeComputer(overrides: {
  upgrades: RedisComputerUpgradeStore;
  online?: boolean;
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
  });
  expect(queued).toEqual([{ computerId: "computer-1", imageId: "sha256:new" }]);
  expect(publications).toEqual([]);
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
