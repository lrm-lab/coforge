import type { OwnedProcessIdentity, OwnedProcessTreeKillReport } from "@lrm/coforge-anvil";
import { bootClockMs, linuxProcessTable } from "./linux-process-table";

export type ProcessTable = Readonly<{
  list(): Promise<readonly OwnedProcessIdentity[]>;
  /** The finest difference between two start times the table can tell apart; defaults to one second. */
  resolutionMs?: number;
}>;

export const psProcessTable: ProcessTable = {
  async list() {
    if (process.platform === "win32") return [];
    const child = Bun.spawn({
      cmd: ["ps", "-axo", "pid=,ppid=,pgid=,lstart="],
      // `lstart` is local time with locale-dependent month and weekday names; pin both so it is
      // read back the way it is printed on any system language.
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error("Host process table unavailable");
    return output.split("\n").flatMap(parseProcessTableLine);
  },
};

export const hostProcessTable: ProcessTable =
  process.platform === "linux" ? linuxProcessTable : psProcessTable;

/**
 * The clock the host process table's start times and every turn-scoped cutoff are on: the boot
 * clock on Linux, wall time elsewhere. A cutoff is stamped when its turn or tool call starts,
 * so it is never converted later; wall-clock slew over a long turn cannot shift it against a
 * child's start time.
 */
export const processClockMs: () => number = process.platform === "linux" ? bootClockMs : Date.now;

function parseProcessTableLine(line: string): OwnedProcessIdentity[] {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) return [];
  const startedAtMs = Date.parse(`${match[4]!} UTC`);
  if (!Number.isFinite(startedAtMs)) return [];
  return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedAtMs }];
}

export function descendantsOf(
  main: OwnedProcessIdentity,
  all: readonly OwnedProcessIdentity[],
): OwnedProcessIdentity[] {
  const byParent = new Map<number, OwnedProcessIdentity[]>();
  for (const process of all) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const descendants: OwnedProcessIdentity[] = [];
  const queue = [...(byParent.get(main.pid) ?? [])];
  while (queue.length) {
    const process = queue.shift()!;
    descendants.push(process);
    queue.push(...(byParent.get(process.pid) ?? []));
  }
  return descendants;
}

/**
 * Raft's `killTurnProcesses` over a verified owned root, shared by the POSIX and launchd
 * owners. `expectedPpid` is the parent that must still own `pid` — the daemon itself for a
 * direct child, the launchd runner for a relayed one — so a recycled or foreign pid is never
 * signaled. Only descendants whose start falls inside the turn's window are killed; a
 * descendant leading its own process group takes that group with it, and a pid already gone
 * is not an error.
 */
export async function killTurnDescendantsInWindow(
  processTable: ProcessTable,
  pid: number,
  expectedPpid: number,
  startedAfterMs: number,
  startedBeforeMs: number | undefined,
): Promise<OwnedProcessTreeKillReport> {
  const resolutionMs = processTable.resolutionMs ?? 1_000;
  const fenceMs = Math.floor(startedAfterMs / resolutionMs) * resolutionMs;
  const table = await processTable.list();
  const main = table.find((entry) => entry.pid === pid);
  if (!main || main.ppid !== expectedPpid) return { killed: [], leftAlone: [] };
  const killed: number[] = [];
  const leftAlone: number[] = [];
  for (const entry of descendantsOf(main, table)) {
    if (
      entry.startedAtMs < fenceMs ||
      (startedBeforeMs !== undefined && entry.startedAtMs > startedBeforeMs)
    ) {
      leftAlone.push(entry.pid);
      continue;
    }
    const groupKill = entry.pgid === entry.pid;
    try {
      globalThis.process.kill(groupKill ? -entry.pid : entry.pid, "SIGKILL");
      killed.push(entry.pid);
    } catch (error) {
      const code = (error as { code?: string }).code;
      // A group signal that finds only zombies answers EPERM on macOS, the same "gone"
      // condition ESRCH reports; a single-pid signal has no such ambiguity.
      const gone =
        code === "ESRCH" || (groupKill && process.platform === "darwin" && code === "EPERM");
      if (!gone) throw error;
    }
  }
  return { killed, leftAlone };
}
