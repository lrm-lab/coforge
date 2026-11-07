import { expect, test } from "bun:test";
import { UPGRADE_ERROR_CODE } from "@lrm/coforge-sdk/internal";
import {
  MachineSupervisor,
  UPGRADE_OPERATION_HISTORY,
  type ManagedBinding,
  type PendingUpgradeSettler,
} from "#src/supervisor/machine-supervisor";
import { UpgradeOperationPendingError } from "#src/supervisor/upgrade-error";

const NOW = 1_700_000_000_000;

function upgradeFixture(
  initial: Partial<ManagedBinding> = {},
  settlePendingUpgrade?: PendingUpgradeSettler,
) {
  const state = {
    saved: [
      { workspaceId: "a", computerId: "c", workspaceRoot: "/a", enabled: true, ...initial },
    ] as ManagedBinding[],
  };
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => {}, instance: async () => "a" },
    () => NOW,
    {},
    settlePendingUpgrade,
  );
  return { state, supervisor, operations: () => state.saved[0]?.upgradeOperations };
}

test("only one upgrade operation may be pending, and a replay is not a second launch", async () => {
  const { supervisor, operations } = upgradeFixture();
  await supervisor.recover();

  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3-rc.1")).toBe(true);
  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3-rc.1")).toBe(false);
  await expect(supervisor.recordUpgrade("a", "request-a", "9.9.9")).rejects.toThrow(
    "different expected version",
  );
  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.3")).rejects.toThrow(
    "request-a is still pending",
  );
  expect(operations()).toEqual([
    { requestId: "request-a", expectedVersion: "1.2.3-rc.1", state: "pending", requestedAt: NOW },
  ]);
});

test("recordUpgrade's pending refusal is a typed error carrying UPGRADE_OPERATION_PENDING", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  const rejection = await supervisor
    .recordUpgrade("a", "request-b", "1.2.4")
    .catch((error: unknown) => error);
  expect(rejection).toBeInstanceOf(UpgradeOperationPendingError);
  expect((rejection as UpgradeOperationPendingError).code).toBe(
    UPGRADE_ERROR_CODE.OPERATION_PENDING,
  );
});

test("recordUpgrade settles an already-receipted pending operation instead of refusing, then accepts the new request", async () => {
  const settleCalls: [string, string, number][] = [];
  const { supervisor, operations } = upgradeFixture(
    {},
    async (workspaceId, requestId, requestedAt) => {
      settleCalls.push([workspaceId, requestId, requestedAt]);
      return { status: "succeeded", version: "1.2.3-rc.1", at: NOW };
    },
  );
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3-rc.1");

  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
  expect(settleCalls).toEqual([["a", "request-a", NOW]]);
  expect(operations()).toEqual([
    {
      requestId: "request-a",
      expectedVersion: "1.2.3-rc.1",
      state: "succeeded",
      requestedAt: NOW,
      terminal: { version: "1.2.3-rc.1", at: NOW },
    },
    { requestId: "request-b", expectedVersion: "1.2.4", state: "pending", requestedAt: NOW },
  ]);
});

test("recordUpgrade still refuses when the settle check reports the pending operation is genuinely in flight", async () => {
  const { supervisor, operations } = upgradeFixture({}, async () => undefined);
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
  expect(operations()).toEqual([
    { requestId: "request-a", expectedVersion: "1.2.3", state: "pending", requestedAt: NOW },
  ]);
});

test("recordUpgrade still refuses when the settle check itself fails", async () => {
  const { supervisor, operations } = upgradeFixture({}, async () => {
    throw new Error("receipt directory is unreadable");
  });
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
  expect(operations()?.[0]?.state).toBe("pending");
});

test("without a settle check configured, recordUpgrade keeps refusing exactly as before", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.recordUpgrade("a", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
});

test("an operation moves from pending through its receipt to the server acknowledgement", async () => {
  const { supervisor, operations } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  expect(
    await supervisor.completeUpgrade("a", "request-a", {
      status: "failed",
      error: "candidate failed",
      at: 7,
    }),
  ).toBe(true);
  expect(operations()).toEqual([
    {
      requestId: "request-a",
      expectedVersion: "1.2.3",
      state: "failed",
      requestedAt: NOW,
      terminal: { error: "candidate failed", at: 7 },
    },
  ]);
  // A receipt only ever resolves a pending operation; a late duplicate is ignored.
  expect(await supervisor.completeUpgrade("a", "request-a", { status: "succeeded", at: 8 })).toBe(
    false,
  );

  expect(await supervisor.acknowledgeUpgrade("a", "request-a")).toBe(true);
  expect(operations()?.[0]?.state).toBe("acknowledged");
  // An acknowledged operation no longer blocks the next one.
  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
});

test("immediately completing a recorded operation as failed (a launch that never started) leaves nothing pending for the next request", async () => {
  const { supervisor, operations } = upgradeFixture();
  await supervisor.recover();

  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3")).toBe(true);
  // Mirrors run-supervisor.ts's `daemon:upgrade` handler: `launchComputerUpgrade` failed, so the
  // operation `recordUpgrade` just opened is settled as failed immediately rather than left
  // "pending" for the full TTL.
  expect(
    await supervisor.completeUpgrade("a", "request-a", {
      status: "failed",
      at: NOW + 1,
      error: "external Computer upgrade coordinator was rejected",
      errorCode: "UPGRADE_LAUNCH_FAILED",
    }),
  ).toBe(true);
  expect(operations()?.[0]).toEqual({
    requestId: "request-a",
    expectedVersion: "1.2.3",
    state: "failed",
    requestedAt: NOW,
    terminal: {
      error: "external Computer upgrade coordinator was rejected",
      errorCode: "UPGRADE_LAUNCH_FAILED",
      at: NOW + 1,
    },
  });
  // Nothing is left pending: a brand-new request is accepted outright, with no settle check
  // configured and no "still pending" refusal.
  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
});

test("a pending operation cannot be acknowledged and unknown operations are ignored", async () => {
  const { supervisor } = upgradeFixture();
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  await expect(supervisor.acknowledgeUpgrade("a", "request-a")).rejects.toThrow(
    "pending Computer upgrade operation cannot be acknowledged",
  );
  expect(await supervisor.acknowledgeUpgrade("a", "absent")).toBe(false);
  expect(await supervisor.completeUpgrade("a", "absent", { status: "succeeded", at: 1 })).toBe(
    false,
  );
});

test("operation history stays capped at the audit tail", async () => {
  const { supervisor, operations } = upgradeFixture({
    upgradeOperations: Array.from({ length: UPGRADE_OPERATION_HISTORY }, (_, index) => ({
      requestId: `old-${index}`,
      expectedVersion: "1.0.0",
      state: "acknowledged" as const,
      requestedAt: NOW - 1,
    })),
  });
  await supervisor.recover();

  await supervisor.recordUpgrade("a", "newest", "1.2.3");

  expect(operations()).toHaveLength(UPGRADE_OPERATION_HISTORY);
  expect(operations()?.at(-1)?.requestId).toBe("newest");
  expect(operations()?.some((entry) => entry.requestId === "old-0")).toBe(false);
});

function machineUpgradeFixture(
  workspaceIds: string[],
  settlePendingUpgrade?: PendingUpgradeSettler,
) {
  const state = {
    saved: workspaceIds.map(
      (workspaceId): ManagedBinding => ({
        workspaceId,
        computerId: "c",
        workspaceRoot: `/${workspaceId}`,
        enabled: true,
      }),
    ),
  };
  const supervisor = new MachineSupervisor(
    {
      load: async () => structuredClone(state.saved),
      save: async (next) => {
        state.saved = structuredClone(next);
      },
    },
    { start: async () => "a", stop: async () => {}, instance: async () => "a" },
    () => NOW,
    {},
    settlePendingUpgrade,
  );
  return {
    state,
    supervisor,
    operationsOf: (workspaceId: string) =>
      state.saved.find((entry) => entry.workspaceId === workspaceId)?.upgradeOperations,
  };
}

test("an upgrade records on every binding and a pending one on any binding refuses the next request", async () => {
  const { supervisor, operationsOf } = machineUpgradeFixture(["a", "b"]);
  await supervisor.recover();

  // Admission is machine-wide: any binding's requestId opens the one pending slot and the
  // record fans out onto every binding (the CLI's daemon:computer_upgrade admits through the
  // same recordUpgrade entry point).
  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3")).toBe(true);
  for (const workspaceId of ["a", "b"])
    expect(operationsOf(workspaceId)).toEqual([
      {
        requestId: "request-a",
        expectedVersion: "1.2.3",
        state: "pending",
        requestedAt: NOW,
      },
    ]);

  // The same request replayed through either binding is not a second launch.
  expect(await supervisor.recordUpgrade("a", "request-a", "1.2.3")).toBe(false);
  expect(await supervisor.recordUpgrade("b", "request-a", "1.2.3")).toBe(false);
  await expect(supervisor.recordUpgrade("a", "request-a", "9.9.9")).rejects.toThrow(
    "different expected version",
  );
  // A pending operation on binding "a"'s copy blocks a request scoped to "b" too: the upgrade
  // mutates the whole machine, so the pending slot is machine-wide.
  await expect(supervisor.recordUpgrade("b", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
});

test("a settle-able pending operation settles on every binding before the next request is admitted", async () => {
  const settleCalls: [string, string, number][] = [];
  const { supervisor, operationsOf } = machineUpgradeFixture(["a", "b"], async (w, r, at) => {
    settleCalls.push([w, r, at]);
    return { status: "succeeded", version: "1.2.3", at: NOW };
  });
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  expect(await supervisor.recordUpgrade("b", "request-b", "1.2.4")).toBe(true);
  // The settle check runs once per pending operation, not once per binding copy.
  expect(settleCalls).toEqual([["a", "request-a", NOW]]);
  for (const workspaceId of ["a", "b"]) {
    const settled = operationsOf(workspaceId)?.find((entry) => entry.requestId === "request-a");
    expect(settled).toMatchObject({
      state: "succeeded",
      terminal: { version: "1.2.3", at: NOW },
    });
    expect(
      operationsOf(workspaceId)?.find((entry) => entry.requestId === "request-b"),
    ).toMatchObject({ state: "pending" });
  }
});

test("completing a request on every binding settles each copy once and a second pass is a no-op", async () => {
  const { supervisor, operationsOf } = machineUpgradeFixture(["a", "b", "c"]);
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  const terminal = {
    status: "failed" as const,
    at: NOW + 1,
    error: "installer refused",
    errorCode: "UPGRADE_LAUNCH_FAILED",
  };
  // The receipt is request-keyed: one delivery resolves every copy (the Coordinator's machine
  // completion calls completeUpgrade once per carrier binding).
  for (const workspaceId of ["a", "b", "c"])
    expect(await supervisor.completeUpgrade(workspaceId, "request-a", terminal)).toBe(true);
  for (const workspaceId of ["a", "b", "c"])
    expect(operationsOf(workspaceId)?.[0]).toMatchObject({
      requestId: "request-a",
      state: "failed",
      terminal: { error: "installer refused", errorCode: "UPGRADE_LAUNCH_FAILED", at: NOW + 1 },
    });
  // A second settle of the same request is a no-op on every copy.
  for (const workspaceId of ["a", "b", "c"])
    expect(
      await supervisor.completeUpgrade(workspaceId, "request-a", {
        status: "succeeded",
        at: 2,
      }),
    ).toBe(false);
  expect(await supervisor.recordUpgrade("a", "request-b", "1.2.4")).toBe(true);
});

test("a binding added while an upgrade is pending is still protected by the machine-wide scan", async () => {
  const { state, supervisor, operationsOf } = machineUpgradeFixture(["a"]);
  await supervisor.recover();
  await supervisor.recordUpgrade("a", "request-a", "1.2.3");

  // A configure adds binding "b" mid-upgrade: its own recordUpgrade must see "a"'s pending copy.
  state.saved.push({
    workspaceId: "b",
    computerId: "c",
    workspaceRoot: "/b",
    enabled: true,
  });
  await supervisor.recover();

  await expect(supervisor.recordUpgrade("b", "request-b", "1.2.4")).rejects.toThrow(
    "request-a is still pending",
  );
  // The pending record was never written to "b" (it did not exist at admission), and the
  // refusal did not fan a copy out either.
  expect(operationsOf("b")).toBeUndefined();
});
