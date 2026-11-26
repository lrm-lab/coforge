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
    async readMany(keys) {
      return keys.map((key) => rows.get(key) ?? null);
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
    expect((await store.read(origin, [], "completed"))?.switchState).toBe("conflict");
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
  expect((await store.read(origin, [], "completed"))?.switchState).toBe("confirmed");
});

test("a legacy terminal result does not use an empty progress registration", async () => {
  const { store, advance } = await fixture();
  const read = (status?: "failed" | "completed") => store.read(origin, ["binding-a"], status);

  expect(await read()).toMatchObject({ switchState: "pending", workspaces: [] });
  expect(await read("failed")).toBeUndefined();
  expect(await read("completed")).toBeUndefined();

  advance(deadline);
  expect(await read()).toMatchObject({ switchState: "uncertain", workspaces: [] });
  expect(await read("failed")).toBeUndefined();
  expect(await read("completed")).toBeUndefined();
});

test("a terminal failure overrides an intermediate phase while a rollback stays visible", async () => {
  const { store } = await fixture();
  const read = () => store.read(origin, ["binding-a"], "failed");
  const evidence = { generation, version: "2.0.0", at: 1_100 };
  await store.recordMachine(origin, { ...evidence, kind: "phase", phase: "downloading" });
  expect((await store.read(origin, ["binding-a"]))?.phase).toBe("downloading");
  expect(await read()).toBeUndefined();

  await store.recordMachine(origin, {
    ...evidence,
    kind: "receipt",
    outcome: "rolled_back",
    restoredVersion: "1.0.0",
    oldProcesses: "verified",
  });
  expect(await read()).toMatchObject({ switchState: "rolled_back", restoredVersion: "1.0.0" });
});

test("a target on the expected version keeps progress when the new Installer reported a phase", async () => {
  const { store } = await fixture();
  await store.recordMachine(origin, {
    kind: "phase",
    phase: "switching",
    generation,
    version: "2.0.0",
    at: 1_100,
  });
  expect(await store.read(origin, ["binding-a"], "completed")).toMatchObject({
    switchState: "target_online",
    phase: "switching",
  });
});

test("only evidence-backed progress can outlive a legacy status record", async () => {
  const { store, advance, snapshot } = await fixture();
  const phaseOnly = { ...origin, requestId: "phase-only" };
  const receiptOnly = { ...origin, requestId: "receipt-only" };
  for (const reporter of [phaseOnly, receiptOnly]) {
    await store.begin(reporter, "2.0.0", deadline, [reporter]);
  }
  await store.recordMachine(phaseOnly, {
    kind: "phase",
    phase: "waiting",
    generation,
    version: "2.0.0",
    at: 1_100,
  });
  await store.recordMachine(receiptOnly, {
    kind: "receipt",
    outcome: "rolled_back",
    restoredVersion: "1.0.0",
    oldProcesses: "verified",
    generation,
    version: "2.0.0",
    at: 1_100,
  });
  const empty = { ...origin, requestId: "empty" };
  await store.begin(empty, "2.0.0", deadline, [empty]);
  await store.recordMachine(origin, snapshot);
  await store.recordReady(other, confirmed);
  const missing = { ...origin, requestId: "missing" };
  advance(deadline);

  expect(await store.hasEvidenceMany([empty, phaseOnly, receiptOnly, missing, origin])).toEqual([
    false,
    true,
    true,
    false,
    true,
  ]);
  expect(await store.read(empty, [], null)).toBeUndefined();
  expect(await store.read(phaseOnly, [], null)).toMatchObject({ phase: "waiting" });
  expect(await store.read(receiptOnly, [], null)).toMatchObject({ switchState: "rolled_back" });
  expect(await store.read(origin, ["binding-b"], null)).toMatchObject({
    switchState: "target_online",
    workspaces: [{ state: "restored" }],
  });
});

test("recordMachineBatch applies multiple machine events in one persistence CAS pass", async () => {
  let reads = 0;
  let replaces = 0;
  const rows = new Map<string, string>();
  const persistence: UpgradeProgressPersistence = {
    async read(key) {
      reads += 1;
      return rows.get(key) ?? null;
    },
    async readMany(keys) {
      return keys.map((key) => rows.get(key) ?? null);
    },
    async replace(key, previous, next) {
      replaces += 1;
      if ((rows.get(key) ?? null) !== previous) return false;
      rows.set(key, next);
      return true;
    },
  };
  const store = new ComputerUpgradeProgressStore(persistence, () => 1_000);
  await store.begin(origin, "2.0.0", deadline, [
    { workspaceId: "a", bindingId: "binding-a", previousWorkerId: "old-a" },
    { workspaceId: "b", bindingId: "binding-b", previousWorkerId: "old-b" },
  ]);
  reads = 0;
  replaces = 0;

  const outcome = await store.recordMachineBatch(origin, [
    {
      kind: "snapshot",
      version: "2.0.0",
      generation,
      at: 1_100,
      bindings: [
        { workspaceId: "a", state: "running" },
        { workspaceId: "b", state: "running" },
      ],
    },
    { kind: "phase", phase: "switching", version: "2.0.0", generation, at: 1_200 },
    { kind: "healthy", version: "2.0.0", generation, at: 1_300 },
    {
      kind: "receipt",
      outcome: "promoted",
      oldProcesses: "verified",
      version: "2.0.0",
      generation,
      at: 1_400,
    },
  ]);

  expect(outcome).toBe("stored");
  expect(reads).toBe(1);
  expect(replaces).toBe(1);
  expect(await store.read(origin, ["binding-a"])).toMatchObject({
    phase: "switching",
    reconnectUntil: 121_000,
    switchState: "pending",
    workspaces: [{ workspaceId: "a", state: "waiting" }],
  });
  expect((await store.read(origin, ["binding-a"], "completed"))?.switchState).toBe("confirmed");

  reads = 0;
  replaces = 0;
  const rejected = await store.recordMachineBatch(origin, [
    { kind: "phase", phase: "waiting", version: "9.9.9", generation, at: 1_500 },
  ]);
  expect(rejected).toBe("rejected");
  expect(reads).toBe(1);
  expect(replaces).toBe(0);
});

test("acceptComputerUpgradeProgress verifies binding without opening a database transaction", async () => {
  const { acceptComputerUpgradeProgress } =
    await import("#src/server/computers/computer-upgrade-progress-wire.server");
  let transactions = 0;
  let queries = 0;
  let sawForShare = false;
  const db = {
    $transaction: async () => {
      transactions += 1;
      throw new Error("should not open a transaction around Redis I/O");
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      queries += 1;
      if (strings.join("").toUpperCase().includes("FOR SHARE")) sawForShare = true;
      return [];
    },
  };
  const status = await acceptComputerUpgradeProgress(
    db as never,
    {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      computerId: "00000000-0000-4000-8000-000000000002",
      apiKeyHash: "hash",
    },
    { kind: "ready", receipt: "invalid-token" },
  );
  expect(status).toBe(403);
  expect(transactions).toBe(0);
  expect(queries).toBe(1);
  expect(sawForShare).toBe(false);
});
