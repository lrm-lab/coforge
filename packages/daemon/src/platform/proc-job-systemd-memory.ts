import { basename, join, posix } from "node:path";
import { isExitedProcState, parseProcStat } from "./linux-process-table";

export type ProcScopeMemoryVerification = (input: {
  unit: string;
  pid: number;
  limitBytes: number;
  signal: AbortSignal;
}) => Promise<boolean>;

const SCOPE_PROPERTIES = [
  "ActiveState",
  "ControlGroup",
  "InvocationID",
  "MemoryAccounting",
  "MemoryMax",
  "MemorySwapMax",
  "OOMPolicy",
] as const;

export function readProcJobScopeGroup(
  show: string,
  unit: string,
  limitBytes: number,
): string | undefined {
  const values = new Map<string, string>();
  for (const line of show.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator);
    if (values.has(name)) return undefined;
    values.set(name, line.slice(separator + 1));
  }
  const group = values.get("ControlGroup");
  const invocationId = values.get("InvocationID") ?? "";
  if (
    !group?.startsWith("/") ||
    group.startsWith("//") ||
    posix.normalize(group) !== group ||
    basename(group) !== unit ||
    !/^[0-9a-f]{32}$/.test(invocationId) ||
    /^0+$/.test(invocationId) ||
    values.get("ActiveState") !== "active" ||
    values.get("MemoryAccounting") !== "yes" ||
    values.get("MemoryMax") !== String(limitBytes) ||
    values.get("MemorySwapMax") !== "0" ||
    values.get("OOMPolicy") !== "kill"
  )
    return undefined;
  return group;
}

async function scopeProperties(unit: string, signal: AbortSignal): Promise<string | undefined> {
  const probe = Bun.spawn(
    [
      "systemctl",
      "--user",
      "show",
      ...SCOPE_PROPERTIES.map((name) => `--property=${name}`),
      "--",
      unit,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      signal,
      timeout: 750,
    },
  );
  const [raw, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
  return code === 0 ? raw : undefined;
}

async function readAnchor(pid: number) {
  const stat = parseProcStat(await Bun.file(`/proc/${pid}/stat`).text());
  return stat?.pgid === pid && !isExitedProcState(stat.state) ? stat.startTicks : undefined;
}

async function verifiedKernelLimit(
  pid: number,
  group: string,
  limitBytes: number,
): Promise<boolean> {
  const folder = join("/sys/fs/cgroup", group);
  const [membership, memoryMax, swapMax, oomGroup] = await Promise.all([
    Bun.file(`/proc/${pid}/cgroup`).text(),
    Bun.file(join(folder, "memory.max")).text(),
    Bun.file(join(folder, "memory.swap.max")).text(),
    Bun.file(join(folder, "memory.oom.group")).text(),
  ]);
  return (
    membership.trim() === `0::${group}` &&
    memoryMax.trim() === String(limitBytes) &&
    swapMax.trim() === "0" &&
    oomGroup.trim() === "1"
  );
}

export const verifyProcJobMemoryScope: ProcScopeMemoryVerification = async ({
  unit,
  pid,
  limitBytes,
  signal,
}) => {
  if (process.platform !== "linux") return false;
  let anchor: number | undefined;
  try {
    anchor = await readAnchor(pid);
  } catch {
    return false;
  }
  if (anchor === undefined) return false;

  while (!signal.aborted) {
    try {
      const properties = await scopeProperties(unit, signal);
      const group = properties && readProcJobScopeGroup(properties, unit, limitBytes);
      if (group && (await verifiedKernelLimit(pid, group, limitBytes))) {
        const currentAnchor = await readAnchor(pid);
        return !signal.aborted && currentAnchor === anchor;
      }
    } catch {
      if (signal.aborted) return false;
    }
    await Bun.sleep(25);
  }
  return false;
};
