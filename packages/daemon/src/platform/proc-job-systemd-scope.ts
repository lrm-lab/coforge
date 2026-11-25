import { join } from "node:path";
import {
  CGROUP_ROOT,
  decodeProcJobMemoryScopeIdentity,
  procJobCgroupDirectoryIdentity,
  readProcJobLinuxBootId,
  resolveProcScopeControl,
  scopeProperties,
  scopePropertiesMatchIdentity,
  type ProcJobMemoryScopeIdentity,
} from "./proc-job-systemd-memory";

type ScopeState = "populated" | "gone" | "unknown";
type ScopeTarget = { systemdUnit?: string; memoryScope?: ProcJobMemoryScopeIdentity };

export async function observeProcJobMemoryScope(
  target: ScopeTarget,
  platform: NodeJS.Platform,
): Promise<ScopeState> {
  const scope =
    target.systemdUnit && decodeProcJobMemoryScopeIdentity(target.memoryScope, target.systemdUnit);
  if (!scope || platform !== "linux") return "unknown";
  try {
    if ((await readProcJobLinuxBootId()) !== scope.bootId) return "gone";
    if ((await procJobCgroupDirectoryIdentity(CGROUP_ROOT)) !== scope.rootDirectory)
      return "unknown";
  } catch {
    return "unknown";
  }
  const folder = join(CGROUP_ROOT, scope.group);
  try {
    if ((await procJobCgroupDirectoryIdentity(folder)) !== scope.directory) return "unknown";
    const events = await Bun.file(join(folder, "cgroup.events")).text();
    if ((await procJobCgroupDirectoryIdentity(folder)) !== scope.directory) return "unknown";
    const populated = /^populated ([01])$/m.exec(events)?.[1];
    return populated === "1" ? "populated" : populated === "0" ? "gone" : "unknown";
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") return "unknown";
    const root = await procJobCgroupDirectoryIdentity(CGROUP_ROOT).catch(() => undefined);
    if (root !== scope.rootDirectory) return "unknown";
    try {
      await procJobCgroupDirectoryIdentity(folder);
      return "unknown";
    } catch (missing) {
      return (missing as { code?: string }).code === "ENOENT" ? "gone" : "unknown";
    }
  }
}

export async function readProcJobMemoryScopeUsage(
  target: ScopeTarget,
  platform: NodeJS.Platform,
  sources = { root: CGROUP_ROOT, readBootId: readProcJobLinuxBootId },
): Promise<number | undefined> {
  const scope =
    target.systemdUnit && decodeProcJobMemoryScopeIdentity(target.memoryScope, target.systemdUnit);
  if (!scope || platform !== "linux") return undefined;
  const folder = join(sources.root, scope.group);
  const matchesDirectories = async () =>
    (await procJobCgroupDirectoryIdentity(sources.root)) === scope.rootDirectory &&
    (await procJobCgroupDirectoryIdentity(folder)) === scope.directory;
  try {
    if ((await sources.readBootId()) !== scope.bootId || !(await matchesDirectories()))
      return undefined;
    const events = await Bun.file(join(folder, "cgroup.events")).text();
    if (!/^populated 1$/m.test(events)) return undefined;
    const current = (await Bun.file(join(folder, "memory.current")).text()).trim();
    if (!/^\d+$/.test(current) || !(await matchesDirectories())) return undefined;
    const bytes = Number(current);
    return Number.isSafeInteger(bytes) ? bytes : undefined;
  } catch {
    return undefined;
  }
}

async function signalProcJobMemoryScope(
  target: ScopeTarget,
  platform: NodeJS.Platform,
  signal: "SIGTERM" | "SIGKILL",
): Promise<boolean> {
  const { systemdUnit, memoryScope } = target;
  if (!systemdUnit || !memoryScope) return false;
  try {
    const control = resolveProcScopeControl();
    const status = await scopeProperties(systemdUnit, AbortSignal.timeout(1_000), control);
    if (!status || !scopePropertiesMatchIdentity(status, memoryScope)) return false;
    if ((await observeProcJobMemoryScope(target, platform)) !== "populated") return false;
    const request = Bun.spawn(
      [
        control.systemctlPath,
        "--user",
        "--no-ask-password",
        "kill",
        "--kill-whom=all",
        `--signal=${signal}`,
        "--",
        systemdUnit,
      ],
      {
        cwd: "/",
        env: control.environment,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 2_000,
      },
    );
    return (await request.exited) === 0;
  } catch {
    return false;
  }
}

export async function stopProcJobMemoryScope(
  target: ScopeTarget,
  options: { platform: NodeJS.Platform; force?: boolean; graceMs?: number; killWaitMs?: number },
): Promise<"stopped" | "already_exited" | "failed"> {
  const state = await observeProcJobMemoryScope(target, options.platform);
  if (state === "gone") return "already_exited";
  if (state !== "populated") return "failed";
  let delivered = false;
  const wait = async (ms: number): Promise<boolean> => {
    const deadline = performance.now() + ms;
    do {
      if ((await observeProcJobMemoryScope(target, options.platform)) === "gone") return true;
      await Bun.sleep(50);
    } while (performance.now() < deadline);
    return false;
  };
  if (!options.force) {
    delivered = await signalProcJobMemoryScope(target, options.platform, "SIGTERM");
    if (await wait(options.graceMs ?? 10_000)) return delivered ? "stopped" : "already_exited";
  }
  delivered = (await signalProcJobMemoryScope(target, options.platform, "SIGKILL")) || delivered;
  if (await wait(options.killWaitMs ?? 2_000)) return delivered ? "stopped" : "already_exited";
  return "failed";
}
