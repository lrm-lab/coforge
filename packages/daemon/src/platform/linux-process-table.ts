import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import type { OwnedProcessIdentity } from "@lrm/coforge-anvil";

/**
 * `/proc/<pid>/stat` reports a process's start time in clock ticks on the boot clock
 * (`start_boottime`; /proc/uptime counts the same clock, suspend included). `ps -o lstart` derives
 * it from a whole-second boot time and truncates to seconds, so on Linux it can name a start up to
 * two seconds earlier than the process really began. That is too coarse for the turn fence, which
 * must tell a child the turn just started from one that was already running.
 *
 * USER_HZ, the unit of that field, is 100 on every Linux architecture but Alpha.
 */
const TICKS_PER_SECOND = 100;
const TICK_MS = 1_000 / TICKS_PER_SECOND;

export type ProcStat = Readonly<{ state: string; ppid: number; pgid: number; startTicks: number }>;

export function parseProcStat(stat: string): ProcStat | undefined {
  const endOfCommand = stat.lastIndexOf(")");
  if (endOfCommand < 0) return undefined;
  const fields = stat
    .slice(endOfCommand + 1)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (state?.length !== 1 || ![ppid, pgid, startTicks].every(Number.isSafeInteger))
    return undefined;
  return { state, ppid, pgid, startTicks };
}

export function isExitedProcState(state: string | undefined): boolean {
  return state === "Z" || state === "X" || state === "x";
}

async function readEntry(pid: number): Promise<OwnedProcessIdentity | undefined> {
  try {
    const parsed = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (!parsed) return undefined;
    return {
      pid,
      ppid: parsed.ppid,
      pgid: parsed.pgid,
      startedAtMs: parsed.startTicks * TICK_MS,
    };
  } catch {
    // The process exited between listing /proc and reading it.
    return undefined;
  }
}

/** Read the kernel's decimal centiseconds as integers so equal stat/uptime ticks stay equal. */
export function parseProcUptimeMs(uptime: string): number {
  const match = /^(\d+)\.(\d{2})(?:\s|$)/.exec(uptime);
  if (!match) throw new Error("Invalid /proc/uptime");
  return Number(match[1]) * 1_000 + Number(match[2]) * 10;
}

/**
 * Milliseconds the system has been up, suspend included: the clock `starttime` is measured on, at
 * the resolution `/proc/uptime` prints (10 ms). It reads synchronously on purpose: it stamps a turn
 * or tool call at the instant it starts, from a callback that cannot wait, and one small procfs
 * read costs microseconds.
 */
export function bootClockMs(): number {
  return parseProcUptimeMs(readFileSync("/proc/uptime", "utf8"));
}

/**
 * The Linux process table. `startedAtMs` is on the boot clock (`bootClockMs`), not wall time, so a
 * process's identity is its exact tick count: two reads of one process agree whatever the wall
 * clock does in between.
 */
export const linuxProcessTable = {
  resolutionMs: TICK_MS,
  async list(): Promise<readonly OwnedProcessIdentity[]> {
    const names = await readdir("/proc");
    const entries = await Promise.all(
      names.filter((name) => /^\d+$/.test(name)).map((name) => readEntry(Number(name))),
    );
    return entries.filter((entry): entry is OwnedProcessIdentity => entry !== undefined);
  },
};
