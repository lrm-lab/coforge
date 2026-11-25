import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isExitedProcState, parseProcStat } from "./linux-process-table";
import { procJobGroupAnchorCommand, procJobGroupHasMembers } from "./proc-job-group-anchor";
import { procJobScopeGateCommand, type ProcJobScopePayload } from "./proc-job-scope-gate";
import {
  readProcJobLinuxBootId,
  resolveProcScopeControl,
  verifyProcJobMemoryScope,
  type ProcScopeControl,
  type ProcJobMemoryScopeIdentity,
  type ProcScopeMemoryVerification,
} from "./proc-job-systemd-memory";
import { observeProcJobMemoryScope, stopProcJobMemoryScope } from "./proc-job-systemd-scope";

export type ProcJobStopTarget = {
  pid: number;
  pgid: number | null;
  startIdentity?: string;
  systemdUnit?: string;
  groupAnchor?: true;
  groupAnchorBootId?: string;
  memoryScope?: ProcJobMemoryScopeIdentity;
  memory?: { mode: "process_group_rss" | "systemd_cgroup" };
};

export type ProcJobIdentity = {
  pgid: number | null;
  startIdentity: string;
  zombie: boolean;
};

export type ProcJobAliveCheck = {
  alive: boolean;
  pgid: number | null;
  identity: ProcJobIdentity | null;
};

const USER_SYSTEMD_STATES = new Set([
  "initializing",
  "starting",
  "running",
  "degraded",
  "maintenance",
]);

export async function readProcJobIdentity(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcJobIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (platform === "linux") {
    try {
      const parsed = parseProcStat(await Bun.file(`/proc/${pid}/stat`).text());
      if (!parsed) return null;
      return {
        pgid: parsed.pgid > 0 ? parsed.pgid : null,
        startIdentity: `linux-starttime:${parsed.startTicks}`,
        zombie: isExitedProcState(parsed.state),
      };
    } catch {
      return null;
    }
  }
  if (platform === "darwin") {
    try {
      const child = Bun.spawn(
        ["/bin/ps", "-ww", "-o", "pid=,pgid=,stat=,lstart=", "-p", String(pid)],
        {
          env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          timeout: 5_000,
        },
      );
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      if (code !== 0) return null;
      const line = output.trim().split("\n")[0]?.trim() ?? "";
      const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!match || Number(match[1]) !== pid) return null;
      const pgid = Number(match[2]);
      return {
        pgid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null,
        startIdentity: `ps-lstart:${match[4]!.trim()}`,
        zombie: match[3]!.startsWith("Z"),
      };
    } catch {
      return null;
    }
  }
  return null;
}

export async function isVerifiedProcJobAlive(
  target: { pid: number; startIdentity?: string },
  platform: NodeJS.Platform = process.platform,
  readIdentity: typeof readProcJobIdentity = readProcJobIdentity,
): Promise<ProcJobAliveCheck> {
  if (!target.startIdentity) return { alive: false, pgid: null, identity: null };
  const identity = await readIdentity(target.pid, platform);
  if (!identity || identity.zombie || identity.startIdentity !== target.startIdentity)
    return { alive: false, pgid: null, identity };
  return { alive: true, pgid: identity.pgid, identity };
}

export async function requireProcJobGroupBootId(
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  return platform === "linux" ? readProcJobLinuxBootId() : undefined;
}

async function bootMayContainProcJobGroup(
  target: ProcJobStopTarget,
  platform: NodeJS.Platform,
): Promise<boolean | undefined> {
  if (!target.groupAnchor || platform !== "linux") return true;
  if (!target.groupAnchorBootId) return undefined;
  try {
    return (await requireProcJobGroupBootId(platform)) === target.groupAnchorBootId;
  } catch {
    return undefined;
  }
}

export async function verifyProcJobGroupAnchor(
  target: ProcJobStopTarget,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!target.groupAnchor || target.pgid !== target.pid) return false;
  if ((await bootMayContainProcJobGroup(target, platform)) !== true) return false;
  const current = await isVerifiedProcJobAlive(target, platform);
  return current.alive && current.pgid === target.pgid;
}

export async function procJobOwnership(
  target: ProcJobStopTarget,
  platform: NodeJS.Platform,
): Promise<"verified" | "gone" | "unknown"> {
  if (target.memoryScope || target.memory?.mode === "systemd_cgroup") {
    const scope = await observeProcJobMemoryScope(target, platform);
    return scope === "populated" ? "verified" : scope;
  }
  const sameBoot = await bootMayContainProcJobGroup(target, platform);
  if (sameBoot !== true) return sameBoot === undefined ? "unknown" : "gone";
  const current = await isVerifiedProcJobAlive(target, platform);
  if (current.alive)
    return target.groupAnchor && current.pgid !== target.pgid ? "unknown" : "verified";
  return target.groupAnchor && !(await procJobGroupIsEmpty(target, platform)) ? "unknown" : "gone";
}

export async function procJobMayBeRunning(
  target: ProcJobStopTarget,
  platform: NodeJS.Platform,
): Promise<boolean> {
  return (await procJobOwnership(target, platform)) !== "gone";
}

async function procJobGroupIsEmpty(
  target: ProcJobStopTarget,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!target.groupAnchor) return true;
  if (target.pgid !== target.pid) return false;
  return (await procJobGroupHasMembers(target.pgid, platform)) === false;
}

function signalOne(
  target: number,
  signal: "SIGTERM" | "SIGKILL",
  isGroup: boolean,
  platform: NodeJS.Platform,
): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ESRCH") return false;
    if (isGroup && platform === "darwin" && code === "EPERM") return false;
    if (code === "EPERM") throw error;
    return false;
  }
}

function signalVerifiedTarget(
  pid: number,
  pgid: number | null,
  signal: "SIGTERM" | "SIGKILL",
  platform: NodeJS.Platform,
): boolean {
  if (pgid !== null && pgid > 1 && pgid !== process.pid) {
    if (signalOne(-pgid, signal, true, platform)) return true;
  }
  return signalOne(pid, signal, false, platform);
}

export async function stopSystemdScopeUnit(
  unit: string,
  signal: "SIGTERM" | "SIGKILL",
): Promise<void> {
  try {
    const child = Bun.spawn(["systemctl", "--user", "kill", "--signal", signal, unit], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 3_000,
    });
    await child.exited;
  } catch {}
}

export async function stopVerifiedProcJob(
  target: ProcJobStopTarget,
  options: {
    force?: boolean;
    requireDeliveredSignal?: boolean;
    graceMs?: number;
    killWaitMs?: number;
    platform?: NodeJS.Platform;
    readIdentity?: typeof readProcJobIdentity;
    signalSystemdUnit?: (unit: string, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  } = {},
): Promise<"stopped" | "already_exited" | "failed"> {
  const platform = options.platform ?? process.platform;
  if (target.memoryScope || target.memory?.mode === "systemd_cgroup")
    return stopProcJobMemoryScope(target, { ...options, platform });
  const readIdentity = options.readIdentity ?? readProcJobIdentity;
  const signalUnit = options.signalSystemdUnit ?? stopSystemdScopeUnit;
  const graceMs = options.graceMs ?? 10_000;
  const killWaitMs = options.killWaitMs ?? 2_000;

  const sameBoot = await bootMayContainProcJobGroup(target, platform);
  if (sameBoot !== true) return sameBoot === undefined ? "failed" : "already_exited";
  const initial = await isVerifiedProcJobAlive(target, platform, readIdentity);
  if (!initial.alive)
    return (await procJobGroupIsEmpty(target, platform)) ? "already_exited" : "failed";
  if (target.groupAnchor && (initial.pgid !== target.pid || target.pgid !== target.pid))
    return "failed";

  let delivered = false;
  const stopped = () =>
    options.requireDeliveredSignal && !delivered
      ? ("already_exited" as const)
      : ("stopped" as const);
  if (!options.force) {
    if (target.systemdUnit && platform === "linux") await signalUnit(target.systemdUnit, "SIGTERM");
    delivered = signalVerifiedTarget(target.pid, initial.pgid ?? target.pgid, "SIGTERM", platform);
    const termDeadline = Date.now() + graceMs;
    while (Date.now() < termDeadline) {
      await Bun.sleep(50);
      const check = await isVerifiedProcJobAlive(target, platform, readIdentity);
      if (!check.alive && (await procJobGroupIsEmpty(target, platform))) return stopped();
    }
  }

  const beforeKill = await isVerifiedProcJobAlive(target, platform, readIdentity);
  if (!beforeKill.alive)
    return (await procJobGroupIsEmpty(target, platform)) ? stopped() : "failed";
  if (target.groupAnchor && beforeKill.pgid !== target.pid) return "failed";

  if (target.systemdUnit && platform === "linux") await signalUnit(target.systemdUnit, "SIGKILL");
  delivered =
    signalVerifiedTarget(target.pid, beforeKill.pgid ?? target.pgid, "SIGKILL", platform) ||
    delivered;
  const killDeadline = Date.now() + killWaitMs;
  while (Date.now() < killDeadline) {
    await Bun.sleep(50);
    const check = await isVerifiedProcJobAlive(target, platform, readIdentity);
    if (!check.alive && (await procJobGroupIsEmpty(target, platform))) return stopped();
  }
  return "failed";
}

export async function detectUserSystemdRun(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  if (platform !== "linux") return false;
  if (!Bun.which("systemd-run") || !Bun.which("systemctl")) return false;
  try {
    const child = Bun.spawn(["systemctl", "--user", "is-system-running"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2_000,
    });
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const state = output.trim();
    return (code === 0 || state === "degraded") && USER_SYSTEMD_STATES.has(state);
  } catch {
    return false;
  }
}

async function assertExecutableAvailable(
  executable: string,
  cwd: string,
  pathEnv: string | undefined,
): Promise<void> {
  if (executable.includes("/")) {
    const info = await stat(resolve(cwd, executable));
    if (!info.isFile()) throw new Error(`executable is not a file: ${executable}`);
    return;
  }
  if (!Bun.which(executable, { cwd, PATH: pathEnv ?? "" }))
    throw new Error(`executable not found on PATH: ${executable}`);
}

const SCOPE_VERIFY_TIMEOUT_MS = 3_000;

async function verifyScopeBeforeExec(
  child: {
    pid: number;
    exited: Promise<number>;
    stdin: Bun.FileSink;
    kill(signal: "SIGKILL"): void;
  },
  unit: string,
  limitBytes: number,
  verify: ProcScopeMemoryVerification,
  timeoutMs: number,
  payload: Buffer,
): Promise<ProcJobMemoryScopeIdentity | undefined> {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  try {
    const verified = await Promise.race([
      Promise.resolve()
        .then(() => verify({ unit, pid: child.pid, limitBytes, signal: controller.signal }))
        .catch(() => false),
      child.exited.then(() => false),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!verified || performance.now() >= deadline)
      throw new Error("Could not verify the scope memory limit before executing the job.");
    const sent = await child.stdin.write(payload);
    if (sent !== payload.byteLength) throw new Error("Could not release the scope execution gate.");
    await child.stdin.end();
    released = true;
    return typeof verified === "object" ? verified : undefined;
  } finally {
    controller.abort();
    clearTimeout(timeout);
    if (!released) child.kill("SIGKILL");
  }
}

export async function spawnDetachedProcJob(input: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  systemdUnit?: string;
  memoryLimitBytes?: number;
  verifySystemdMemoryScope?: ProcScopeMemoryVerification;
  verifyTimeoutMs?: number;
  scopeControl?: ProcScopeControl;
  groupAnchor?: true;
  onExit(exitCode: number | null, signal: string | null): void;
}): Promise<{ pid: number; startIdentity?: string; memoryScope?: ProcJobMemoryScopeIdentity }> {
  if (input.groupAnchor && input.systemdUnit)
    throw new Error("A sampled process group cannot run in a managed systemd scope.");
  if (input.systemdUnit || input.groupAnchor)
    await assertExecutableAvailable(input.command[0]!, input.cwd, input.env.PATH);
  const limit = input.memoryLimitBytes;
  if (limit !== undefined && (!input.systemdUnit || !Number.isSafeInteger(limit) || limit <= 0))
    throw new Error("A scope memory limit requires a systemd unit and positive byte limit.");
  const scopeControl =
    limit === undefined ? undefined : (input.scopeControl ?? resolveProcScopeControl());
  const payload =
    scopeControl || input.groupAnchor
      ? Buffer.from(
          JSON.stringify({
            command: input.command,
            cwd: input.cwd,
            env: input.env,
          } satisfies ProcJobScopePayload),
        )
      : undefined;
  const cappedScopeArgs =
    limit === undefined
      ? []
      : [
          "--description=CoForge Agent background job",
          "--property=MemoryAccounting=yes",
          `--property=MemoryMax=${limit}`,
          "--property=MemorySwapMax=0",
          "--property=OOMPolicy=kill",
        ];
  const command = input.groupAnchor
    ? procJobGroupAnchorCommand()
    : scopeControl
      ? procJobScopeGateCommand()
      : input.command;
  const argv = input.systemdUnit
    ? [
        scopeControl?.systemdRunPath ?? "systemd-run",
        "--quiet",
        "--user",
        "--scope",
        "--unit",
        input.systemdUnit,
        "--collect",
        ...cappedScopeArgs,
        "--",
        ...command,
      ]
    : command;
  const fd = openSync(input.logPath, "a", 0o600);
  try {
    const child = Bun.spawn(argv, {
      cwd: payload ? "/" : input.cwd,
      env:
        scopeControl?.environment ??
        (input.groupAnchor ? { PATH: "/usr/bin:/bin", LC_ALL: "C" } : input.env),
      stdin: payload ? "pipe" : "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
      onExit(_proc, exitCode, signalCode) {
        input.onExit(exitCode ?? null, signalCode ? String(signalCode) : null);
      },
    });
    let memoryScope: ProcJobMemoryScopeIdentity | undefined;
    if (limit !== undefined && input.systemdUnit && scopeControl && payload) {
      if (!child.stdin) {
        child.kill("SIGKILL");
        throw new Error("The scope execution gate has no approval pipe.");
      }
      memoryScope = await verifyScopeBeforeExec(
        {
          pid: child.pid,
          exited: child.exited,
          stdin: child.stdin,
          kill: (signal) => child.kill(signal),
        },
        input.systemdUnit,
        limit,
        input.verifySystemdMemoryScope ??
          ((request) => verifyProcJobMemoryScope(request, scopeControl)),
        Math.min(input.verifyTimeoutMs ?? SCOPE_VERIFY_TIMEOUT_MS, SCOPE_VERIFY_TIMEOUT_MS),
        payload,
      );
    }
    let anchorIdentity: ProcJobIdentity | null = null;
    if (input.groupAnchor && payload) {
      try {
        anchorIdentity = await readProcJobIdentity(child.pid);
        if (!anchorIdentity || anchorIdentity.zombie || anchorIdentity.pgid !== child.pid)
          throw new Error("Could not verify a dedicated process group for the job.");
        if (!child.stdin || (await child.stdin.write(payload)) !== payload.byteLength)
          throw new Error("Could not deliver the sampled job payload.");
        await child.stdin.end();
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }
    }
    child.unref();
    return {
      pid: child.pid,
      ...(anchorIdentity ? { startIdentity: anchorIdentity.startIdentity } : {}),
      ...(memoryScope ? { memoryScope } : {}),
    };
  } finally {
    closeSync(fd);
  }
}
