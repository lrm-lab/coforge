import { stat } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import { z } from "zod";
import { isExitedProcState, parseProcStat } from "./linux-process-table";

type ProcScopeMemoryVerificationInput = {
  unit: string;
  pid: number;
  limitBytes: number;
  signal: AbortSignal;
};

export type ProcScopeMemoryVerification = (
  input: ProcScopeMemoryVerificationInput,
) => Promise<boolean | ProcJobMemoryScopeIdentity>;

export type ProcScopeControl = {
  systemdRunPath: string;
  systemctlPath: string;
  environment: Record<string, string>;
};

const SCOPE_CONTROL_PATH = "/usr/bin:/bin";

export function resolveProcScopeControl(): ProcScopeControl {
  const systemdRunPath = Bun.which("systemd-run", { PATH: SCOPE_CONTROL_PATH });
  const systemctlPath = Bun.which("systemctl", { PATH: SCOPE_CONTROL_PATH });
  if (!systemdRunPath || !systemctlPath)
    throw new Error("Trusted systemd executables are unavailable.");
  const environment: Record<string, string> = { PATH: SCOPE_CONTROL_PATH, LC_ALL: "C" };
  for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) {
    const value = Bun.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return { systemdRunPath, systemctlPath, environment };
}

export type ProcJobMemoryScopeIdentity = {
  bootId: string;
  invocationId: string;
  group: string;
  directory: string;
  rootDirectory: string;
};

export const CGROUP_ROOT = "/sys/fs/cgroup";

export function readProcJobLinuxBootId(): Promise<string> {
  return Bun.file("/proc/sys/kernel/random/boot_id")
    .text()
    .then((id) => {
      const bootId = id.trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(bootId))
        throw new Error("Could not verify the Linux boot identity.");
      return bootId;
    });
}

function matchesScopePath(group: string, unit: string): boolean {
  return (
    /^[A-Za-z0-9_-]+\.scope$/.test(unit) &&
    group.startsWith("/") &&
    !group.startsWith("//") &&
    !group.includes("\0") &&
    posix.normalize(group) === group &&
    basename(group) === unit
  );
}

function validInvocationId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

const procJobMemoryScopeIdentitySchema = z.object({
  bootId: z.string().regex(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/),
  invocationId: z.string().refine(validInvocationId),
  group: z.string(),
  directory: z.string().regex(/^\d+:\d+$/),
  rootDirectory: z.string().regex(/^\d+:\d+$/),
});

export function decodeProcJobMemoryScopeIdentity(
  value: unknown,
  unit: string,
): ProcJobMemoryScopeIdentity | undefined {
  const parsed = procJobMemoryScopeIdentitySchema.safeParse(value);
  if (!parsed.success || !matchesScopePath(parsed.data.group, unit)) return undefined;
  return parsed.data;
}

export async function procJobCgroupDirectoryIdentity(folder: string): Promise<string> {
  const identity = await stat(folder, { bigint: true });
  if (!identity.isDirectory()) throw new Error("Invalid cgroup directory.");
  return `${identity.dev}:${identity.ino}`;
}

const SCOPE_PROPERTIES = [
  "ActiveState",
  "ControlGroup",
  "InvocationID",
  "MemoryAccounting",
  "MemoryMax",
  "MemorySwapMax",
  "OOMPolicy",
] as const;

function readProcJobScopeProperties(show: string): Map<string, string> | undefined {
  const values = new Map<string, string>();
  for (const line of show.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator);
    if (values.has(name)) return undefined;
    values.set(name, line.slice(separator + 1));
  }
  return values;
}

function verifiedScopeProperties(
  show: string,
  unit: string,
  limitBytes: number,
): { group: string; invocationId: string } | undefined {
  const values = readProcJobScopeProperties(show);
  if (!values) return undefined;
  const group = values.get("ControlGroup");
  const invocationId = values.get("InvocationID") ?? "";
  if (
    !group ||
    !matchesScopePath(group, unit) ||
    !validInvocationId(invocationId) ||
    values.get("ActiveState") !== "active" ||
    values.get("MemoryAccounting") !== "yes" ||
    values.get("MemoryMax") !== String(limitBytes) ||
    values.get("MemorySwapMax") !== "0" ||
    values.get("OOMPolicy") !== "kill"
  )
    return undefined;
  return { group, invocationId };
}

export function readProcJobScopeGroup(
  show: string,
  unit: string,
  limitBytes: number,
): string | undefined {
  return verifiedScopeProperties(show, unit, limitBytes)?.group;
}

export function scopePropertiesMatchIdentity(
  show: string,
  identity: ProcJobMemoryScopeIdentity,
): boolean {
  const values = readProcJobScopeProperties(show);
  return (
    values?.get("ControlGroup") === identity.group &&
    values.get("InvocationID") === identity.invocationId
  );
}

export async function scopeProperties(
  unit: string,
  signal: AbortSignal,
  control: ProcScopeControl,
): Promise<string | undefined> {
  const probe = Bun.spawn(
    [
      control.systemctlPath,
      "--user",
      "show",
      ...SCOPE_PROPERTIES.map((name) => `--property=${name}`),
      "--",
      unit,
    ],
    {
      cwd: "/",
      env: control.environment,
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
  const folder = join(CGROUP_ROOT, group);
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

export async function verifyProcJobMemoryScope(
  { unit, pid, limitBytes, signal }: ProcScopeMemoryVerificationInput,
  control: ProcScopeControl,
): Promise<ProcJobMemoryScopeIdentity | false> {
  if (process.platform !== "linux") return false;
  let anchor: number | undefined;
  let bootId: string;
  let rootDirectory: string;
  try {
    [anchor, bootId, rootDirectory] = await Promise.all([
      readAnchor(pid),
      readProcJobLinuxBootId(),
      procJobCgroupDirectoryIdentity(CGROUP_ROOT),
    ]);
  } catch {
    return false;
  }
  if (anchor === undefined) return false;

  while (!signal.aborted) {
    try {
      const properties = await scopeProperties(unit, signal, control);
      const scope = properties && verifiedScopeProperties(properties, unit, limitBytes);
      if (scope) {
        const folder = join(CGROUP_ROOT, scope.group);
        const directory = await procJobCgroupDirectoryIdentity(folder);
        if (!(await verifiedKernelLimit(pid, scope.group, limitBytes))) {
          await Bun.sleep(25);
          continue;
        }
        const [currentAnchor, currentDirectory, currentRoot] = await Promise.all([
          readAnchor(pid),
          procJobCgroupDirectoryIdentity(folder),
          procJobCgroupDirectoryIdentity(CGROUP_ROOT),
        ]);
        return !signal.aborted &&
          currentAnchor === anchor &&
          currentDirectory === directory &&
          currentRoot === rootDirectory
          ? { ...scope, directory, rootDirectory, bootId }
          : false;
      }
    } catch {
      if (signal.aborted) return false;
    }
    await Bun.sleep(25);
  }
  return false;
}
