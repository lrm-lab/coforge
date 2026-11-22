import { expect, test } from "bun:test";
import {
  ComputerUpgradeProgressStore,
  type UpgradeProgressPersistence,
} from "#src/server/computers/computer-upgrade-progress.server";

const attempt = { computerId: "computer", requestId: "attempt" };
const origin = { ...attempt, workspaceId: "a", bindingId: "binding-a" };
const other = { ...attempt, workspaceId: "b", bindingId: "binding-b" };
const generation = "install-generation";
const deadline = 601_000;
const confirmed = {
  ...other,
  generation,
  version: "2.0.0",
  workerId: "new-b",
  readyRequestId: "ready-b",
  confirmedAt: 2_000,
  expiresAt: deadline,
};

async function fixture() {
  let now = 1_000;
  let failWrite = false;
  const rows = new Map<string, string>();
  const persistence: UpgradeProgressPersistence = {
    async read(key) {
      return rows.get(key) ?? null;
    },
    async replace(key, previous, next) {
      if (failWrite) throw new Error("detail storage unavailable");
      if ((rows.get(key) ?? null) !== previous) return false;
      rows.set(key, next);
      return true;
    },
  };
  const store = new ComputerUpgradeProgressStore(persistence, () => now);
  await store.begin(origin, "2.0.0", deadline, [
    { workspaceId: "a", bindingId: "binding-a", previousWorkerId: "old-a" },
    { workspaceId: "b", bindingId: "binding-b", previousWorkerId: "old-b" },
  ]);
  const snapshot = {
    kind: "snapshot" as const,
    version: "2.0.0",
    generation,
    at: 1_100,
    bindings: [
      { workspaceId: "a", state: "running" as const },
      { workspaceId: "b", state: "running" as const },
    ],
  };
  return {
    store,
    snapshot,
    failWrites(value: boolean) {
      failWrite = value;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

test("early workspace ready is reconciled only with the originating binding's snapshot", async () => {
  const { store, snapshot } = await fixture();
  expect(await store.recordReady(other, confirmed)).toBe("stored");
  expect(await store.recordMachine(other, snapshot)).toBe("rejected");
  expect((await store.read(origin, ["binding-a", "binding-b"]))?.workspaces).toEqual([]);
  await store.recordMachine(origin, snapshot);
  expect(await store.recordReady(other, confirmed)).toBe("stored");
  expect(await store.read(origin, ["binding-a", "binding-b"])).toMatchObject({
    switchState: "target_online",
    workspaces: [
      { workspaceId: "a", state: "waiting" },
      { workspaceId: "b", state: "restored", confirmedAt: confirmed.confirmedAt },
    ],
  });
});

test("a reattached workspace cannot submit or see the old ready row", async () => {
  const { store, snapshot } = await fixture();
  await store.recordMachine(origin, snapshot);
  expect(await store.recordReady({ ...other, bindingId: "replacement-b" }, confirmed)).toBe(
    "rejected",
  );
  expect(await store.recordReady(other, { ...confirmed, generation: "independent-install" })).toBe(
    "rejected",
  );
  expect(await store.recordReady(other, { ...confirmed, workerId: "old-b" })).toBe("rejected");
  expect((await store.read(origin, ["binding-a", "replacement-b"]))?.workspaces).toEqual([
    { workspaceId: "a", state: "waiting" },
  ]);
});

test("a ready receipt can be submitted again after detail storage fails without changing its time", async () => {
  const { store, snapshot, failWrites, advance } = await fixture();
  await store.recordMachine(origin, snapshot);
  failWrites(true);
  await expect(store.recordReady(other, confirmed)).rejects.toThrow("detail storage unavailable");
  expect((await store.read(origin, ["binding-b"]))?.workspaces[0]?.state).toBe("waiting");
  failWrites(false);
  advance(1_500);
  expect(await store.recordReady(other, confirmed)).toBe("stored");
  advance(4_000);
  expect(await store.recordReady(other, confirmed)).toBe("stored");
  expect((await store.read(origin, ["binding-b"]))?.workspaces).toEqual([
    { workspaceId: "b", state: "restored", confirmedAt: confirmed.confirmedAt },
  ]);
});

test("an online target is separate from the installer proof and conflicting late evidence", async () => {
  const { store, snapshot } = await fixture();
  await store.recordMachine(origin, snapshot);
  await store.recordReady(other, confirmed);
  expect((await store.read(origin, ["binding-b"]))?.switchState).toBe("target_online");
  await store.recordMachine(origin, {
    kind: "receipt",
    generation,
    version: "2.0.0",
    outcome: "promoted",
    oldProcesses: "unknown",
    at: 3_000,
  });
  expect((await store.read(origin, ["binding-b"]))?.switchState).toBe("target_online");
  await store.recordMachine(origin, {
    kind: "receipt",
    generation,
    version: "2.0.0",
    outcome: "rolled_back",
    oldProcesses: "verified",
    at: 4_000,
  });
  expect((await store.read(origin, ["binding-b"]))?.switchState).toBe("conflict");
});

test("only confirmed visible bindings drive the fixed reconnect window", async () => {
  const { store, snapshot, advance } = await fixture();
  await store.recordMachine(origin, snapshot);
  await store.recordReady(other, confirmed);
  advance(1_000);
  const healthy = { kind: "healthy" as const, generation, version: "2.0.0", at: 1_500 };
  await store.recordMachine(origin, healthy);
  expect((await store.read(origin, ["binding-b"]))?.reconnectUntil).toBeUndefined();
  expect((await store.read(origin, ["binding-a", "binding-b"]))?.reconnectUntil).toBe(122_000);
  advance(121_000);
  await store.recordMachine(origin, healthy);
  expect((await store.read(origin, ["binding-b"]))?.reconnectUntil).toBeUndefined();
  expect((await store.read(origin, ["binding-a"]))?.workspaces).toEqual([
    { workspaceId: "a", state: "unconfirmed" },
  ]);
});

test("hidden binding recovery leaves the visible result identical to a single binding", async () => {
  const { store, snapshot } = await fixture();
  await store.recordMachine(origin, snapshot);
  await store.recordReady(origin, {
    ...confirmed,
    ...origin,
    workerId: "new-a",
    readyRequestId: "ready-a",
  });
  await store.recordMachine(origin, { kind: "healthy", generation, version: "2.0.0", at: 2_000 });
  const before = await store.read(origin, ["binding-a"]);
  await store.recordReady(other, confirmed);
  expect(await store.read(origin, ["binding-a"])).toEqual(before);
  expect(before?.reconnectUntil).toBeUndefined();
  expect(before?.workspaces.map(({ workspaceId }) => workspaceId)).toEqual(["a"]);
});

test("an installer commit with uncertain durability does not claim a switch or an online target", async () => {
  const { store } = await fixture();
  await store.recordMachine(origin, {
    kind: "phase",
    generation,
    version: "2.0.0",
    phase: "uncertain",
    at: 2_000,
  });
  expect(await store.read(origin, ["binding-a", "binding-b"])).toMatchObject({
    phase: "uncertain",
    switchState: "uncertain",
    workspaces: [],
  });
});

test("signed ready deduplicates a binding and generation across replacement processes", async () => {
  const { store, snapshot } = await fixture();
  await store.recordMachine(origin, snapshot);
  expect(await store.identifyReady(other, generation)).toBeDefined();
  await store.recordReady(other, confirmed);
  expect(await store.identifyReady(other, generation)).toBeUndefined();
  expect(await store.identifyReady(origin, generation)).toBeDefined();
  await store.recordReady(other, {
    ...confirmed,
    workerId: "replacement",
    readyRequestId: "another-request",
    confirmedAt: confirmed.confirmedAt - 1,
  });
  expect((await store.read(origin, ["binding-b"]))?.workspaces).toEqual([
    { workspaceId: "b", state: "restored", confirmedAt: confirmed.confirmedAt },
  ]);
});

const receipt = {
  kind: "receipt" as const,
  generation,
  version: "2.0.0",
  oldProcesses: "unknown" as const,
  at: 2_000,
};

for (const order of ["original-first", "recovery-first"] as const) {
  test(`verified recovery supersedes unresolved evidence in ${order} order`, async () => {
    const { store } = await fixture();
    const original = { ...receipt, outcome: "unresolved" as const };
    const recovery = {
      ...receipt,
      outcome: "rolled_back" as const,
      oldProcesses: "verified" as const,
      restoredVersion: "1.0.0",
      at: 3_000,
    };
    if (order === "original-first") {
      await store.recordMachine(origin, original);
      expect((await store.read(origin, []))?.switchState).toBe("uncertain");
      await store.recordMachine(origin, recovery);
    } else {
      await store.recordMachine(origin, recovery);
      await store.recordMachine(origin, original);
    }
    expect(await store.read(origin, [])).toMatchObject({
      switchState: "rolled_back",
      restoredVersion: "1.0.0",
    });
    expect((await store.read(origin, [], true))?.switchState).toBe("conflict");
    await store.recordMachine(origin, { ...recovery, restoredVersion: "1.1.0" });
    const conflict = await store.read(origin, []);
    expect(conflict?.switchState).toBe("conflict");
    expect(conflict?.restoredVersion).toBeUndefined();
  });
}

test("a recovered promotion can settle journal uncertainty with target online", async () => {
  const { store } = await fixture();
  await store.recordMachine(origin, { ...receipt, kind: "phase", phase: "uncertain" });
  await store.recordMachine(origin, { ...receipt, outcome: "unresolved" });
  await store.recordMachine(origin, {
    ...receipt,
    outcome: "promoted",
    oldProcesses: "verified",
    at: 3_000,
  });
  expect((await store.read(origin, []))?.switchState).toBe("pending");
  expect((await store.read(origin, [], true))?.switchState).toBe("confirmed");
});
