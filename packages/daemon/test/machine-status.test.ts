import { expect, test } from "bun:test";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { MachineStatusReporter } from "#src/daemon-runtime/machine-status-reporter";
import {
  hostMachineStatusIo,
  parseVmStat,
  readDiskStatus,
  readLinuxMemory,
  readMachineMemory,
  type MachineStatusIo,
} from "#src/platform/machine-status";

const GIB = 1024 ** 3;

function io(overrides: Partial<MachineStatusIo> = {}): MachineStatusIo {
  return {
    readFile: async () => "",
    disk: () => ({ availableBytes: 100 * GIB, totalBytes: 500 * GIB }),
    totalMemory: () => 32 * GIB,
    freeMemory: () => 5 * GIB,
    vmStat: () => undefined,
    ...overrides,
  };
}

test("macOS memory counts what the system can hand out, not only pages that are free", async () => {
  // Page size 16 KiB, as on Apple silicon: free 327562, inactive 553496, speculative 7011,
  // purgeable 5683 (measured on the Mac Studio, 2026-10-30).
  const parsed = parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   327562.
Pages active:                                 583847.
Pages inactive:                               553496.
Pages speculative:                              7011.
Pages purgeable:                                5683.`);
  expect(parsed).toEqual({ availableBytes: (327562 + 553496 + 7011 + 5683) * 16384 });
  expect(
    await readMachineMemory(
      "darwin",
      io({
        vmStat: () =>
          "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1.\nPages inactive: 1.\nPages speculative: 1.\nPages purgeable: 1.",
      }),
    ),
  ).toEqual({ availableBytes: 4 * 16384, totalBytes: 32 * GIB });
});

test("macOS falls back to os.freemem only when vm_stat cannot be read", async () => {
  expect(await readMachineMemory("darwin", io())).toEqual({
    availableBytes: 5 * GIB,
    totalBytes: 32 * GIB,
  });
});

test("Linux narrows memory to a cgroup limit and gives back inactive page cache", async () => {
  const meminfo = "MemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n";
  const files: Record<string, string> = {
    "/proc/meminfo": meminfo,
    "/sys/fs/cgroup/memory.max": "8589934592\n",
    "/sys/fs/cgroup/memory.current": "6442450944\n",
    "/sys/fs/cgroup/memory.stat": "inactive_file 2147483648\n",
  };
  const sample = await readLinuxMemory(
    io({ readFile: async (path) => files[path] ?? Promise.reject(new Error("missing")) }),
  );
  // 8 GiB limit, 6 GiB current of which 2 GiB is reclaimable cache: 4 GiB available.
  expect(sample).toEqual({ availableBytes: 4 * GIB, totalBytes: 8 * GIB });
});

test("Linux without a cgroup limit reports meminfo as-is", async () => {
  const files: Record<string, string> = {
    "/proc/meminfo": "MemTotal:       32768000 kB\nMemAvailable:   16384000 kB\n",
    "/sys/fs/cgroup/memory.max": "max\n",
  };
  const sample = await readLinuxMemory(
    io({ readFile: async (path) => files[path] ?? Promise.reject(new Error("missing")) }),
  );
  expect(sample).toEqual({ availableBytes: 16_384_000 * 1024, totalBytes: 32_768_000 * 1024 });
});

test("a disk that cannot be read, or whose numbers do not add up, is no sample", async () => {
  expect(await readDiskStatus("/agents", io())).toEqual({
    availableBytes: 100 * GIB,
    totalBytes: 500 * GIB,
  });
  expect(await readDiskStatus("/agents", io({ disk: () => undefined }))).toBeUndefined();
  expect(
    await readDiskStatus(
      "/agents",
      io({ disk: () => ({ availableBytes: 600 * GIB, totalBytes: 500 * GIB }) }),
    ),
  ).toBeUndefined();
  expect(
    await readDiskStatus("/agents", io({ disk: () => ({ availableBytes: 1, totalBytes: 0 }) })),
  ).toBeUndefined();
});

function reporter(overrides: {
  transport?: DaemonConnectionClient | undefined;
  io?: MachineStatusIo;
  dataDirectory?: string;
}) {
  const disk: unknown[] = [];
  const memory: unknown[] = [];
  const live = {
    async sendMachineDiskStatus(report: unknown) {
      disk.push(report);
    },
    async sendMachineMemoryStatus(report: unknown) {
      memory.push(report);
    },
  } as unknown as DaemonConnectionClient;
  const value = new MachineStatusReporter({
    connection: () => ({ workspaceId: "workspace-a", computerId: "computer-a" }),
    dataDirectory: () => overrides.dataDirectory ?? "/agents",
    transport: () => ("transport" in overrides ? overrides.transport : live),
    io: overrides.io ?? io(),
    platform: "darwin",
    now: () => 1_700_000_000_000,
  });
  return { value, disk, memory };
}

test("a report names the connection it belongs to and carries the sample", async () => {
  const { value, disk, memory } = reporter({});
  await value.reportDisk();
  await value.reportMemory();
  expect(disk).toEqual([
    {
      protocolMajor: 1,
      requestId: expect.any(String),
      workspaceId: "workspace-a",
      computerId: "computer-a",
      reportedAtMs: 1_700_000_000_000,
      availableBytes: 100 * GIB,
      totalBytes: 500 * GIB,
    },
  ]);
  expect(memory).toHaveLength(1);
});

test("nothing is sent without a live connection or without a sane sample", async () => {
  const offline = reporter({ transport: undefined });
  await offline.value.reportDisk();
  await offline.value.reportMemory();
  expect(offline.disk).toEqual([]);
  expect(offline.memory).toEqual([]);

  const blind = reporter({
    io: io({ disk: () => undefined, vmStat: () => undefined, freeMemory: () => 40 * GIB }),
  });
  await blind.value.reportDisk();
  await blind.value.reportMemory();
  expect(blind.disk).toEqual([]);
  // free > total is not a sample either.
  expect(blind.memory).toEqual([]);
});

test("a filesystem the runtime cannot stat is unknown, never an error", async () => {
  // On Windows in particular, `statfsSync` may not exist or may refuse the path: the sample then
  // reads as unknown and nothing is sent, rather than the reporter throwing.
  expect(hostMachineStatusIo().disk("/coforge-does-not-exist-anywhere")).toBeUndefined();
});
