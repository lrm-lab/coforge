import { expect, test } from "bun:test";
import {
  MACHINE_DISK_STATUS_METHOD,
  MACHINE_MEMORY_STATUS_METHOD,
  encodeMachineDiskStatusReport,
  encodeMachineMemoryStatusReport,
  type MachineStatusReport,
} from "@lrm/coforge-sdk/internal";

import { createMachineStatusMethod } from "#src/server/centrifugo/machine-status-receiver.server";
import {
  isMachineDiskLow,
  machineStatusView,
  machineUsageLabel,
  MACHINE_DISK_LOW_BYTES,
  MEMORY_STALE_AFTER_MS,
  DISK_STALE_AFTER_MS,
} from "#src/features/computers/computer-machine-status";

const GIB = 1024 ** 3;

const principal = () => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
});

const report = (overrides: Partial<MachineStatusReport> = {}): MachineStatusReport => ({
  protocolMajor: 1,
  requestId: "machine-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  reportedAtMs: 1_700_000_000_000,
  availableBytes: 100 * GIB,
  totalBytes: 500 * GIB,
  ...overrides,
});

function recorder() {
  const calls: [string, string, MachineStatusReport][] = [];
  return {
    calls,
    store: {
      record: async (kind: "disk" | "memory", computerId: string, value: MachineStatusReport) => {
        calls.push([kind, computerId, value]);
        return true;
      },
    },
  };
}

const call = (
  method: ReturnType<typeof createMachineStatusMethod>,
  payload: Uint8Array,
  metadata: { principal: ReturnType<typeof principal> } = { principal: principal() },
) => method(payload, metadata as never);

test("each kind is stored for the connection's own Computer", async () => {
  const { calls, store } = recorder();
  expect(
    await call(createMachineStatusMethod("disk", store), encodeMachineDiskStatusReport(report())),
  ).toEqual(new Uint8Array());
  expect(
    await call(
      createMachineStatusMethod("memory", store),
      encodeMachineMemoryStatusReport(report({ requestId: "machine-2" })),
    ),
  ).toEqual(new Uint8Array());
  expect(calls.map(([kind, computerId]) => [kind, computerId])).toEqual([
    ["disk", "computer-1"],
    ["memory", "computer-1"],
  ]);
});

test("another Computer's report, or one that does not add up, is refused", async () => {
  const { calls, store } = recorder();
  const disk = createMachineStatusMethod("disk", store);
  expect(
    await call(disk, encodeMachineDiskStatusReport(report()), {
      principal: { ...principal(), computerId: "computer-2" },
    }),
  ).toMatchObject({ code: 403 });
  expect(calls).toEqual([]);
  // The codec refuses a sample that does not add up before it reaches the wire.
  expect(() => encodeMachineDiskStatusReport({ ...report(), availableBytes: 600 * GIB })).toThrow(
    "invalid machine status report",
  );
  expect(await call(disk, new Uint8Array())).toMatchObject({ code: 400 });
});

test("both methods are composed under their protocol names", async () => {
  const { machineStatusMethods } =
    await import("#src/server/centrifugo/machine-status-receiver.server");
  expect(Object.keys(machineStatusMethods(null))).toEqual([
    MACHINE_DISK_STATUS_METHOD,
    MACHINE_MEMORY_STATUS_METHOD,
  ]);
  expect(
    await machineStatusMethods(null)[MACHINE_DISK_STATUS_METHOD]!(new Uint8Array(), {
      principal: principal(),
    } as never),
  ).toMatchObject({ code: 503 });
});

test("a reading is shown while fresh, and reads as unknown once stale or absent", () => {
  const at = new Date("2026-10-30T12:00:00Z");
  const row = {
    diskAvailableBytes: 100n * BigInt(GIB),
    diskTotalBytes: 500n * BigInt(GIB),
    diskReportedAt: at,
    memoryAvailableBytes: 12n * BigInt(GIB),
    memoryTotalBytes: 32n * BigInt(GIB),
    memoryReportedAt: at,
  };
  const fresh = machineStatusView(row, at.getTime() + 60_000);
  expect(fresh.disk).toEqual({
    availableBytes: 100 * GIB,
    totalBytes: 500 * GIB,
    reportedAt: at.toISOString(),
  });
  expect(fresh.memory?.availableBytes).toBe(12 * GIB);

  // One kind may have a fresh report while the other's is older than its window.
  const partial = machineStatusView(row, at.getTime() + MEMORY_STALE_AFTER_MS + 1);
  expect(partial.memory).toBeNull();
  expect(partial.disk).not.toBeNull();
  expect(machineStatusView(row, at.getTime() + DISK_STALE_AFTER_MS + 1).disk).toBeNull();

  expect(
    machineStatusView(
      { ...row, diskAvailableBytes: null, diskTotalBytes: null, diskReportedAt: null },
      at.getTime(),
    ).disk,
  ).toBeNull();
});

test("a disk is low only when it is nearly full and nearly out of absolute room", () => {
  // Under both thresholds.
  expect(isMachineDiskLow({ availableBytes: 10 * GIB, totalBytes: 1_000 * GIB })).toBe(true);
  // Plenty of absolute room left, even at a small percentage.
  expect(
    isMachineDiskLow({ availableBytes: MACHINE_DISK_LOW_BYTES, totalBytes: 2_000 * GIB }),
  ).toBe(false);
  // A large fraction of a small volume.
  expect(isMachineDiskLow({ availableBytes: 15 * GIB, totalBytes: 100 * GIB })).toBe(false);
  // Small volume, a large share free: not low.
  expect(isMachineDiskLow({ availableBytes: 15 * GIB, totalBytes: 120 * GIB })).toBe(false);
  // Under a tenth of a larger volume: low.
  expect(isMachineDiskLow({ availableBytes: 15 * GIB, totalBytes: 200 * GIB })).toBe(true);
});

test("usage reads used / total: disks in powers of 1000, memory in powers of 1024", () => {
  expect(machineUsageLabel({ availableBytes: 88e9, totalBytes: 500e9 }, 1000)).toBe(
    "412 GB / 500 GB",
  );
  expect(machineUsageLabel({ availableBytes: 588e9, totalBytes: 1e12 }, 1000)).toBe(
    "412 GB / 1 TB",
  );
  expect(machineUsageLabel({ availableBytes: 13.64 * GIB, totalBytes: 32 * GIB }, 1024)).toBe(
    "18 GB / 32 GB",
  );
  expect(machineUsageLabel({ availableBytes: 6.5 * GIB, totalBytes: 8 * GIB }, 1024)).toBe(
    "1.5 GB / 8 GB",
  );
  expect(machineUsageLabel({ availableBytes: 0.4e9, totalBytes: 1e12 }, 1000)).toBe("1 TB / 1 TB");
});
