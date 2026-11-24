import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";

import type {
  NativeProcessIdentity,
  UpgradeWorkspaceInstance,
} from "#src/supervisor/workspace-instance";
import { LAUNCHD_EXIT_TIMEOUT_SECONDS } from "./daemon-stop-wait";
import { nativeCommandDiagnostic, type NativeCommandResult } from "./native-command";
import { escapePlistValue } from "./xml-escape";

/**
 * Native launchd access. Injectable so job lifecycle is testable without
 * creating, signalling, or removing real user jobs.
 */
export type LaunchdJobPlatform = {
  jobs(timeoutMs?: number): Promise<Map<string, number>>;
  records?(timeoutMs?: number): Promise<Map<string, LaunchdJobRecord>>;
  run(args: string[]): Promise<NativeCommandResult>;
};

type LaunchdJobRecord = { pid: number; exitStatus?: number };

export type LaunchdJobConfig = {
  label: string;
  directory: string;
  command: string[];
  environment?: Record<string, string>;
  restartOnFailure?: boolean;
  /** Seconds launchd waits between launches of the job (`ThrottleInterval`). Omit to keep
   * launchd's default of 10 s. */
  throttleIntervalSeconds?: number;
  /** stdout and stderr destination for the job, e.g. a Computer log file. Omit to leave launchd's
   * default (discarded) redirection in place. */
  logPath?: string;
  platform?: LaunchdJobPlatform;
};

/** Native user-job lifecycle. `list` has documented columns; `print` is not an API. */
export class LaunchdJob {
  readonly path: string;
  readonly target: string;
  readonly #platform: LaunchdJobPlatform;
  constructor(readonly config: LaunchdJobConfig) {
    if (!/^cn\.coforge\.[A-Za-z0-9.-]+$/.test(config.label)) throw new Error("invalid job label");
    this.path = join(config.directory, `${config.label}.plist`);
    this.target = `gui/${process.getuid!()}/${config.label}`;
    this.#platform = config.platform ?? nativeLaunchd;
  }

  async ensureStarted(beforeLaunch?: () => Promise<unknown>): Promise<NativeProcessIdentity> {
    const existing = await this.identity();
    if (existing?.active) return existing;
    if (!(await this.#platform.jobs()).has(this.config.label)) {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
      await writeFile(this.path, jobPlist(this.config), { mode: 0o600 });
      if (beforeLaunch) await beforeLaunch();
      await this.#launchctl(["bootstrap", `gui/${process.getuid!()}`, this.path]);
    } else {
      await this.#launchctl(["kickstart", this.target]);
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const identity = await this.identity();
      if (identity?.active) return identity;
      await Bun.sleep(25);
    }
    throw new Error("launchd job did not start");
  }

  async identity(): Promise<NativeProcessIdentity | null> {
    const observed = await this.upgradeInstance();
    return observed === "pending" ? null : observed;
  }

  async upgradeInstance(
    timeoutMs?: number,
    confirmsTerminalExit?: () => Promise<boolean>,
  ): Promise<UpgradeWorkspaceInstance> {
    const job = await this.#jobRecord(timeoutMs);
    if (!job) return null;
    const { pid } = job;
    if (!pid) {
      if (job.exitStatus !== 0 || !(await confirmsTerminalExit?.())) return "pending";
      const current = await this.#jobRecord(timeoutMs);
      return !current || (current.pid === 0 && current.exitStatus === 0) ? null : "pending";
    }
    const observed = await capture(
      ["/bin/ps", "-p", String(pid), "-o", "lstart=", "-o", "pgid=", "-o", "stat="],
      timeoutMs,
    );
    if (observed.code === 1 && !observed.stdout.trim()) return "pending";
    const match = observed.stdout.trim().match(/^(.{24})\s+(\d+)\s+(\S+)$/);
    if (observed.code || !match) throw new Error("invalid launchd process identity");
    // launchd can publish the PID before its child has established its process
    // group. This is not a ready identity and must never be adopted or signalled.
    if (Number(match[2]) !== pid || match[3]!.startsWith("Z")) return "pending";
    if ((await this.#jobRecord(timeoutMs))?.pid !== pid) return "pending";
    return { mainPid: pid, active: true, invocationId: `${pid}:${match[1]}` };
  }

  async #jobRecord(timeoutMs?: number): Promise<LaunchdJobRecord | undefined> {
    if (this.#platform.records)
      return (await this.#platform.records(timeoutMs)).get(this.config.label);
    const pid = (await this.#platform.jobs(timeoutMs)).get(this.config.label);
    if (pid !== undefined) return { pid };
  }

  async stop(): Promise<void> {
    const jobs = await this.#platform.jobs();
    const pid = jobs.get(this.config.label);
    if (jobs.has(this.config.label)) {
      try {
        await this.#launchctl(["bootout", this.target]);
      } catch (error) {
        // The Workspace and Coordinator may both finish cleanup. A failed
        // bootout is successful only when a fresh OS query proves removal;
        // the process-group observation below must still complete.
        if ((await this.#platform.jobs()).has(this.config.label)) throw error;
      }
    }
    const deadline = Date.now() + 10_000;
    while (
      (await this.#platform.jobs()).has(this.config.label) ||
      (pid && (await processGroupExists(pid)))
    ) {
      if (Date.now() >= deadline) throw new Error("launchd job cleanup did not complete");
      await Bun.sleep(25);
    }
    await rm(this.path, { force: true });
  }

  async signal(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void> {
    if ((await this.#platform.jobs()).has(this.config.label))
      await this.#launchctl(["kill", signal, this.target]);
  }

  async #launchctl(args: string[]): Promise<void> {
    const result = await this.#platform.run(args);
    if (!result.code) return;
    const diagnostic = nativeCommandDiagnostic(result.stderr);
    getLogger(["coforge", "daemon", "launchd"]).error("Native job command failed", {
      event: "launchd:command_failed",
      operation: args[0],
      exit_code: result.code,
      ...(diagnostic ? { error_message: diagnostic } : {}),
    });
    throw new Error(
      diagnostic
        ? `launchctl ${args[0]} failed (${result.code}): ${diagnostic}`
        : `launchctl ${args[0]} failed (${result.code})`,
    );
  }
}

export async function launchdJobs(timeoutMs?: number): Promise<Map<string, number>> {
  return new Map(
    [...(await queryLaunchdJobRecords(timeoutMs))].map(([label, record]) => [label, record.pid]),
  );
}

async function queryLaunchdJobRecords(timeoutMs?: number): Promise<Map<string, LaunchdJobRecord>> {
  const result = await capture(["/bin/launchctl", "list"], timeoutMs);
  if (result.code) throw new Error("launchd user manager is unavailable");
  const [header, ...lines] = result.stdout.trim().split("\n");
  if (!/^PID\s+Status\s+Label$/.test(header ?? "")) throw new Error("invalid launchd job list");
  const jobs = new Map<string, LaunchdJobRecord>();
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3 || !/^(\d+|-)$/.test(fields[0]!) || !/^-?\d+$/.test(fields[1]!))
      throw new Error("invalid launchd job list");
    const pid = fields[0] === "-" ? 0 : Number(fields[0]);
    const exitStatus = Number(fields[1]);
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(exitStatus))
      throw new Error("invalid launchd job list");
    jobs.set(fields[2]!, { pid, exitStatus });
  }
  return jobs;
}

/** Refuses anything but one Workspace's Agent job prefix, `cn.coforge.agent.<identity>.`, and
 * returns its launchd identity. */
export function assertAgentJobScope(prefix: string): string {
  const identity = /^cn\.coforge\.agent\.([a-f0-9]{24})\.$/.exec(prefix)?.[1];
  if (!identity) throw new Error("invalid Agent job scope");
  return identity;
}

export async function stopLaunchdJobs(prefix: string, directory: string): Promise<void> {
  assertAgentJobScope(prefix);
  for (const label of (await launchdJobs()).keys()) {
    if (label.startsWith(prefix)) await new LaunchdJob({ label, directory, command: [] }).stop();
  }
}

export async function processGroupExists(pid: number): Promise<boolean> {
  const result = await capture(["/bin/ps", "-axo", "pgid=,stat="]);
  if (result.code) throw new Error("could not observe process groups");
  return result.stdout.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pid && !!state && !state.startsWith("Z");
  });
}

async function capture(command: string[], timeout = 10_000) {
  const child = Bun.spawn(command, {
    env: { LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * launchctl explains a failure only on stderr. Keeping that text is the
 * difference between an actionable log record and a bare exit code, so a
 * failed native command must never discard it.
 */
async function launchctlCommand(args: string[]): Promise<NativeCommandResult> {
  return await capture(["/bin/launchctl", ...args]);
}

const nativeLaunchd: LaunchdJobPlatform = {
  jobs: launchdJobs,
  records: queryLaunchdJobRecords,
  run: launchctlCommand,
};

export function jobPlist(config: LaunchdJobConfig): string {
  const throttle = config.throttleIntervalSeconds;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${escapePlistValue(config.label)}</string>
<key>ProgramArguments</key><array>${config.command.map((arg) => `<string>${escapePlistValue(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(config.environment ?? {})
    .map(
      ([key, value]) =>
        `<key>${escapePlistValue(key)}</key><string>${escapePlistValue(value)}</string>`,
    )
    .join("")}</dict>
<key>RunAtLoad</key><true/>
${config.restartOnFailure ? "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>" : ""}${throttle === undefined ? "" : `\n<key>ThrottleInterval</key><integer>${throttle}</integer>`}
${config.logPath ? `<key>StandardOutPath</key><string>${escapePlistValue(config.logPath)}</string>\n<key>StandardErrorPath</key><string>${escapePlistValue(config.logPath)}</string>` : ""}
<key>AbandonProcessGroup</key><false/>
<key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>
</dict></plist>\n`;
}
