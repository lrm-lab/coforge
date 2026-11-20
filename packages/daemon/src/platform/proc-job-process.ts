import { closeSync, openSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isExitedProcState, parseProcStat } from "./linux-process-table";

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
): void {
  if (pgid !== null && pgid > 1 && pgid !== process.pid) {
    if (signalOne(-pgid, signal, true, platform)) return;
  }
  signalOne(pid, signal, false, platform);
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
  target: { pid: number; pgid: number | null; startIdentity?: string; systemdUnit?: string },
  options: {
    force?: boolean;
    graceMs?: number;
    killWaitMs?: number;
    platform?: NodeJS.Platform;
    readIdentity?: typeof readProcJobIdentity;
    signalSystemdUnit?: (unit: string, signal: "SIGTERM" | "SIGKILL") => Promise<void>;
  } = {},
): Promise<"stopped" | "already_exited" | "failed"> {
  const platform = options.platform ?? process.platform;
  const readIdentity = options.readIdentity ?? readProcJobIdentity;
  const signalUnit = options.signalSystemdUnit ?? stopSystemdScopeUnit;
  const graceMs = options.graceMs ?? 10_000;
  const killWaitMs = options.killWaitMs ?? 2_000;

  const initial = await isVerifiedProcJobAlive(target, platform, readIdentity);
  if (!initial.alive) return "already_exited";

  if (!options.force) {
    if (target.systemdUnit && platform === "linux") await signalUnit(target.systemdUnit, "SIGTERM");
    signalVerifiedTarget(target.pid, initial.pgid ?? target.pgid, "SIGTERM", platform);
    const termDeadline = Date.now() + graceMs;
    while (Date.now() < termDeadline) {
      await Bun.sleep(50);
      const check = await isVerifiedProcJobAlive(target, platform, readIdentity);
      if (!check.alive) return "stopped";
    }
  }

  const beforeKill = await isVerifiedProcJobAlive(target, platform, readIdentity);
  if (!beforeKill.alive) return "stopped";

  if (target.systemdUnit && platform === "linux") await signalUnit(target.systemdUnit, "SIGKILL");
  signalVerifiedTarget(target.pid, beforeKill.pgid ?? target.pgid, "SIGKILL", platform);
  const killDeadline = Date.now() + killWaitMs;
  while (Date.now() < killDeadline) {
    await Bun.sleep(50);
    const check = await isVerifiedProcJobAlive(target, platform, readIdentity);
    if (!check.alive) return "stopped";
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
  if (!Bun.which(executable, { PATH: pathEnv ?? "" }))
    throw new Error(`executable not found on PATH: ${executable}`);
}

export async function spawnDetachedProcJob(input: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  logPath: string;
  systemdUnit?: string;
  onExit(exitCode: number | null, signal: string | null): void;
}): Promise<{ pid: number }> {
  if (input.systemdUnit)
    await assertExecutableAvailable(input.command[0]!, input.cwd, input.env.PATH);
  const argv = input.systemdUnit
    ? [
        "systemd-run",
        "--quiet",
        "--user",
        "--scope",
        "--unit",
        input.systemdUnit,
        "--collect",
        "--",
        ...input.command,
      ]
    : input.command;
  const fd = openSync(input.logPath, "a", 0o600);
  try {
    const child = Bun.spawn(argv, {
      cwd: input.cwd,
      env: input.env,
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
      onExit(_proc, exitCode, signalCode) {
        input.onExit(exitCode ?? null, signalCode ? String(signalCode) : null);
      },
    });
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(fd);
  }
}
