import { statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";

/** What a machine has left, in bytes; `undefined` when it could not be read or made no sense. */
export type MachineSample = { availableBytes: number; totalBytes: number } | undefined;

/** The reads a sample needs, so a test can answer without a real machine. */
export type MachineStatusIo = {
  readFile(path: string): Promise<string>;
  /** `statfsSync` on the path, in bytes; absent where the runtime cannot do it. */
  disk(path: string): { availableBytes: number; totalBytes: number } | undefined;
  totalMemory(): number;
  /** macOS only: `os.freemem`, used when `vm_stat` cannot be read. */
  freeMemory(): number;
  /** macOS only: the `vm_stat` output, or undefined when it cannot be run. */
  vmStat(): string | undefined;
};

export function hostMachineStatusIo(): MachineStatusIo {
  const run = (command: readonly string[]) => {
    try {
      const result = Bun.spawnSync({
        cmd: [...command],
        stdout: "pipe",
        stderr: "ignore",
        timeout: 2_000,
      });
      return result.exitCode === 0 ? result.stdout.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    readFile: (path) => Bun.file(path).text(),
    // `statfsSync` answers bytes; a runtime without it (some Windows builds) reads as unknown
    // rather than failing the sample.
    disk: (path) => {
      try {
        const stats = statfsSync(path);
        return {
          availableBytes: Number(stats.bavail) * Number(stats.bsize),
          totalBytes: Number(stats.blocks) * Number(stats.bsize),
        };
      } catch {
        return undefined;
      }
    },
    totalMemory: totalmem,
    freeMemory: freemem,
    vmStat: () => run(["/usr/bin/vm_stat"]),
  };
}

/** The Agent data directory's filesystem: what is left for Agent workspaces, sessions and state. */
export async function readDiskStatus(
  directory: string,
  io: MachineStatusIo,
): Promise<MachineSample> {
  const sample = io.disk(directory);
  return sample ? valid(sample) : undefined;
}

const MEMINFO = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB$/gm;
const CGROUP_V2_MAX = /^\d+$/;
const INACTIVE_FILE = /^inactive_file\s+(\d+)$/m;

/**
 * Linux memory: `/proc/meminfo` says what the kernel thinks is available, but inside a container
 * the cgroup limit is what the Agent can actually use. A v2 limit narrows the total, and its
 * `memory.current` counts page cache as used, so `inactive_file` comes back off it.
 */
export async function readLinuxMemory(io: MachineStatusIo): Promise<MachineSample> {
  const meminfo = await io.readFile("/proc/meminfo").catch(() => "");
  const fields = new Map(
    [...meminfo.matchAll(MEMINFO)].map((match) => [match[1], Number(match[2])]),
  );
  const total = (fields.get("MemTotal") ?? 0) * 1024;
  const available = (fields.get("MemAvailable") ?? 0) * 1024;
  if (!total || !available) return undefined;
  const limit = await cgroupLimit(io);
  const scope = limit
    ? narrow(total, available, limit)
    : { availableBytes: available, totalBytes: total };
  return scope ? valid(scope) : undefined;
}

/** The cgroup's memory ceiling, when the process runs under one. */
async function cgroupLimit(io: MachineStatusIo): Promise<MachineSample | undefined> {
  // v2: a single number, or "max" when unlimited.
  const v2Max = (await io.readFile("/sys/fs/cgroup/memory.max").catch(() => "")).trim();
  if (CGROUP_V2_MAX.test(v2Max)) {
    const total = Number(v2Max);
    const current = Number(
      (await io.readFile("/sys/fs/cgroup/memory.current").catch(() => "")).trim(),
    );
    const stat = await io.readFile("/sys/fs/cgroup/memory.stat").catch(() => "");
    if (!Number.isFinite(current)) return undefined;
    // Page cache the kernel can reclaim is not memory in use.
    const cached = Number(stat.match(INACTIVE_FILE)?.[1] ?? 0);
    return {
      availableBytes: Math.max(0, total - Math.max(0, current - cached)),
      totalBytes: total,
    };
  }
  // v1: a byte limit, and the same page-cache correction from `memory.stat`.
  const v1Max = Number(
    (await io.readFile("/sys/fs/cgroup/memory/memory.limit_in_bytes").catch(() => "")).trim(),
  );
  const v1Usage = Number(
    (await io.readFile("/sys/fs/cgroup/memory/memory.usage_in_bytes").catch(() => "")).trim(),
  );
  const v1Stat = await io.readFile("/sys/fs/cgroup/memory/memory.stat").catch(() => "");
  // A v1 "unlimited" limit is a huge page-aligned number: anything past 2^60 is no limit.
  if (!Number.isFinite(v1Max) || v1Max <= 0 || v1Max > 2 ** 60 || !Number.isFinite(v1Usage))
    return undefined;
  const cached = Number(v1Stat.match(INACTIVE_FILE)?.[1] ?? 0);
  return { availableBytes: Math.max(0, v1Max - Math.max(0, v1Usage - cached)), totalBytes: v1Max };
}

/** `available` inside a smaller `limit`, keeping the ratio the kernel reported. */
function narrow(
  total: number,
  available: number,
  limit: { availableBytes: number; totalBytes: number },
): { availableBytes: number; totalBytes: number } {
  if (limit.totalBytes >= total) return { availableBytes: available, totalBytes: total };
  const usedInLimit = Math.max(0, limit.totalBytes - limit.availableBytes);
  return {
    availableBytes: Math.max(0, Math.min(available, limit.totalBytes - usedInLimit)),
    totalBytes: limit.totalBytes,
  };
}

/**
 * macOS memory: `os.freemem()` counts only pages that are entirely free, so a Mac that caches
 * everything reads as ~90% used. `vm_stat`'s free, inactive, speculative and purgeable pages are
 * what the system can hand to a new process, which is what the number means to a person.
 */
export function parseVmStat(text: string): { availableBytes: number } | undefined {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  const pages = (name: string) => {
    const match = text.match(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.?$`, "m"));
    return match ? Number(match[1]) : undefined;
  };
  const free = pages("free");
  const inactive = pages("inactive");
  const speculative = pages("speculative");
  // `Pages purgeable` is a budget, not a page category: it moves into free/speculative over time.
  const purgeable = Number(text.match(/^Pages purgeable:\s+(\d+)\.?$/m)?.[1] ?? 0);
  if (!pageSize || free === undefined || inactive === undefined || speculative === undefined)
    return undefined;
  return { availableBytes: (free + inactive + speculative + purgeable) * pageSize };
}

/** macOS: reclaimable memory from `vm_stat`, total from the kernel. */
export function readDarwinMemory(io: MachineStatusIo): MachineSample {
  const total = io.totalMemory();
  const vmStat = io.vmStat();
  const parsed = vmStat ? parseVmStat(vmStat) : undefined;
  if (!parsed) return valid({ availableBytes: io.freeMemory(), totalBytes: total });
  return valid({ availableBytes: parsed.availableBytes, totalBytes: total });
}

/** Windows and anything else: the OS's own free/total figures. */
export function readGenericMemory(io: MachineStatusIo): MachineSample {
  return valid({ availableBytes: io.freeMemory(), totalBytes: io.totalMemory() });
}

/** One sample, whichever machine this is; `undefined` when the numbers cannot be trusted. */
export async function readMachineMemory(
  platform: NodeJS.Platform,
  io: MachineStatusIo,
): Promise<MachineSample> {
  if (platform === "linux") return readLinuxMemory(io);
  if (platform === "darwin") return readDarwinMemory(io);
  return readGenericMemory(io);
}

function valid(sample: { availableBytes: number; totalBytes: number }): MachineSample {
  const { availableBytes, totalBytes } = sample;
  if (
    !Number.isSafeInteger(availableBytes) ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    availableBytes < 0 ||
    availableBytes > totalBytes
  )
    return undefined;
  return sample;
}
