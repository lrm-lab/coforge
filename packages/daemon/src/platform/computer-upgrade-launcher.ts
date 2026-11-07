import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RFC_UUID_PATTERN } from "@lrm/coforge-sdk/internal";
import { systemdPresent } from "../daemon-host/detached";
import { LaunchdJob, type LaunchdJobPlatform } from "./launchd-job";
import { escapeXmlText } from "@lrm/coforge-sdk/internal";
import {
  removeFileQuietly,
  runSchtasks,
  windowsTaskUserId,
  writeUtf16XmlFile,
} from "./windows-scheduled-task";

/** What the upgrade job runs, on every platform: the Computer's own `__remote-upgrade`. */
export function computerUpgradeAction(
  executablePath: string,
  requestId: string,
  expectedVersion: string,
  feedUrl?: string,
): string[] {
  return [
    executablePath,
    "__remote-upgrade",
    "--request-id",
    requestId,
    "--version",
    expectedVersion,
    ...(feedUrl ? ["--release-feed", feedUrl] : []),
  ];
}

export function computerUpgradeCommand(
  platform: NodeJS.Platform,
  executablePath: string,
  requestId: string,
  expectedVersion: string,
  feedUrl?: string,
): string[] {
  if (!RFC_UUID_PATTERN.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  if (!expectedVersion) throw new Error("missing expected Computer release version");
  const action = computerUpgradeAction(executablePath, requestId, expectedVersion, feedUrl);
  if (platform === "linux")
    return [
      "systemd-run",
      "--user",
      "--collect",
      `--unit=${computerUpgradeUnitName(requestId)}`,
      "--property=Type=exec",
      ...action,
    ];
  // Darwin and Windows run this action inside an OS one-shot outside the Coordinator kill
  // scope (launchd job / schtasks). `launchctl submit` must never be used on darwin: launchd
  // keeps a submitted job alive indefinitely and there is no submit(1) flag to disable
  // KeepAlive, so the job respawns forever after the upgrade finishes.
  if (platform === "darwin" || platform === "win32") return action;
  throw new Error("remote Computer upgrade has no safe external coordinator on this platform");
}

/** Transient systemd user unit for a Linux one-shot remote upgrade. */
export function computerUpgradeUnitName(requestId: string): string {
  if (!RFC_UUID_PATTERN.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  return `coforge-upgrade-${requestId}.service`;
}

/** launchd label for a macOS one-shot remote upgrade. */
export function computerUpgradeJobLabel(requestId: string): string {
  if (!RFC_UUID_PATTERN.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  return `cn.coforge.upgrade.${requestId}`;
}

/** User-level Scheduled Task name for a Windows one-shot remote upgrade. */
export function computerUpgradeTaskName(requestId: string): string {
  if (!RFC_UUID_PATTERN.test(requestId)) throw new Error("invalid Computer upgrade request ID");
  return `CoForge Upgrade ${requestId}`;
}

export type ComputerUpgradeJobPaths = {
  label: string;
  directory: string;
  logPath: string;
};

export type ComputerUpgradeJobPathOptions = {
  /** The daemon's own state directory; the job's plist is written under `<stateDirectory>/upgrade-jobs`. */
  stateDirectory?: string;
  homeDirectory?: string;
};

/**
 * Where the darwin upgrade job's plist and its stdout/stderr log live. Kept pure and exported so
 * tests can assert on the paths without touching launchd or the filesystem.
 */
export function computerUpgradeJobPaths(
  requestId: string,
  options: ComputerUpgradeJobPathOptions = {},
): ComputerUpgradeJobPaths {
  const home = options.homeDirectory ?? homedir();
  const stateDirectory = options.stateDirectory ?? join(home, ".coforge", "daemon");
  return {
    label: computerUpgradeJobLabel(requestId),
    directory: join(stateDirectory, "upgrade-jobs"),
    logPath: join(home, ".coforge", "computer", "logs", "computer", `upgrade-${requestId}.log`),
  };
}

export type WindowsUpgradeTaskRunner = (command: string[]) => Promise<number>;

export type LaunchComputerUpgradeOptions = ComputerUpgradeJobPathOptions & {
  /** Explicit official feed selected by the local channel command. */
  feedUrl?: string;
  /** Injectable native launchd access, for tests only. */
  jobPlatform?: LaunchdJobPlatform;
  /** Injectable Windows `schtasks` runner, for tests only. */
  windowsTaskRunner?: WindowsUpgradeTaskRunner;
  /** The platform to launch for; this process's own when absent. Tests inject it. */
  platform?: NodeJS.Platform;
  /** Linux only: whether systemd is present; read from the machine when absent. Tests inject it. */
  hasSystemd?: boolean;
  /** Linux without systemd: starts the action outside this process. Tests inject it. */
  spawnDetached?: (action: string[], logPath: string) => void;
};

/**
 * Linux without systemd (task #538): there is no `systemd-run` to hold the upgrade outside the
 * Coordinator's kill scope, so it runs as a process of its own - a new session (`detached`), no
 * terminal, its output in the same log the other platforms' jobs write. The Coordinator's stop
 * does not reach it, and the receipt it writes is read exactly as for the other platforms.
 */
export function spawnDetachedUpgrade(action: string[], logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, "a");
  try {
    const child = Bun.spawn(action, { stdin: "ignore", stdout: log, stderr: log, detached: true });
    child.unref();
  } finally {
    closeSync(log);
  }
}

export async function launchComputerUpgrade(
  requestId: string,
  expectedVersion: string,
  options: LaunchComputerUpgradeOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const command = computerUpgradeCommand(
    platform,
    process.execPath,
    requestId,
    expectedVersion,
    options.feedUrl,
  );
  if (platform === "darwin") {
    const paths = computerUpgradeJobPaths(requestId, options);
    // RunAtLoad with no KeepAlive: launchd runs the job once when bootstrapped and never
    // restarts it, whatever its exit status. That is the one-shot equivalent of the Linux
    // `systemd-run --property=Type=exec` path above.
    await new LaunchdJob({
      label: paths.label,
      directory: paths.directory,
      command,
      logPath: paths.logPath,
      platform: options.jobPlatform,
    }).ensureStarted();
    return;
  }
  if (platform === "win32") {
    await launchWindowsComputerUpgrade(requestId, command, options.windowsTaskRunner);
    return;
  }
  if (platform === "linux" && !(options.hasSystemd ?? systemdPresent())) {
    const { logPath } = computerUpgradeJobPaths(requestId, options);
    (options.spawnDetached ?? spawnDetachedUpgrade)(
      computerUpgradeAction(process.execPath, requestId, expectedVersion, options.feedUrl),
      logPath,
    );
    return;
  }
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0)
    throw new Error("external Computer upgrade coordinator was rejected");
}

export type WindowsUpgradeTaskXmlInput = {
  userId: string;
  action: string[];
};

/**
 * Locale-independent one-shot Scheduled Task XML. A far-future TimeTrigger is only a
 * registration placeholder so `/Run` can start the upgrade immediately; `/SC ONCE` with a
 * `/SD` date string is rejected on non-US locales (e.g. Chinese Windows expects yyyy/mm/dd).
 */
export function windowsUpgradeTaskXml(input: WindowsUpgradeTaskXmlInput): string {
  if (input.action.length === 0) throw new Error("Windows upgrade task action is empty");
  const [executable, ...args] = input.action;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <TimeTrigger>
      <StartBoundary>2099-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXmlText(input.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(executable!)}</Command>
      <Arguments>${escapeXmlText(args.join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export type LaunchWindowsComputerUpgradeHooks = {
  run?: WindowsUpgradeTaskRunner;
  writeTaskXml?: (path: string, content: string) => Promise<void>;
  removeTaskXml?: (path: string) => Promise<void>;
  userId?: string;
};

/**
 * Registers a one-shot user Scheduled Task and runs it immediately. The task is outside the
 * Coordinator process tree (and any Agent Job Object), matching systemd-run / launchd one-shot
 * kill-scope isolation. XML registration avoids locale-dependent `/SD` date parsing.
 */
export async function launchWindowsComputerUpgrade(
  requestId: string,
  action: string[],
  runOrHooks: WindowsUpgradeTaskRunner | LaunchWindowsComputerUpgradeHooks = {},
): Promise<void> {
  const hooks: LaunchWindowsComputerUpgradeHooks =
    typeof runOrHooks === "function" ? { run: runOrHooks } : runOrHooks;
  const run = hooks.run ?? runSchtasks;
  const writeTaskXml = hooks.writeTaskXml ?? writeUtf16XmlFile;
  const removeTaskXml = hooks.removeTaskXml ?? removeFileQuietly;
  const taskName = computerUpgradeTaskName(requestId);
  const xmlPath = join(tmpdir(), `coforge-upgrade-task-${crypto.randomUUID()}.xml`);
  try {
    await writeTaskXml(
      xmlPath,
      windowsUpgradeTaskXml({
        userId: hooks.userId ?? windowsTaskUserId(),
        action,
      }),
    );
    const created = await run(["schtasks.exe", "/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
    if (created !== 0) throw new Error("external Computer upgrade coordinator was rejected");
    const started = await run(["schtasks.exe", "/Run", "/TN", taskName]);
    if (started !== 0) throw new Error("external Computer upgrade coordinator was rejected");
  } finally {
    await removeTaskXml(xmlPath);
  }
}

/**
 * Best-effort self-cleanup for the `__remote-upgrade` entry point, called once its upgrade result
 * file has been written. The job's plist already has no KeepAlive, so leaving this job in place
 * cannot make it respawn; this only removes the now-idle `launchctl list` entry and its plist so a
 * later retry does not collide with a stale label. `launchctl bootout` targeting your own
 * still-running job is unreliable on some macOS versions, so callers must tolerate this throwing
 * and rely on the Coordinator startup sweep (see computer-upgrade-sweep.ts) as the backstop.
 * On Windows, deletes the one-shot Scheduled Task of the same request id.
 */
export async function cleanupComputerUpgradeJob(
  requestId: string,
  options: LaunchComputerUpgradeOptions = {},
): Promise<void> {
  if (process.platform === "darwin") {
    const paths = computerUpgradeJobPaths(requestId, options);
    await new LaunchdJob({
      label: paths.label,
      directory: paths.directory,
      command: [],
      platform: options.jobPlatform,
    }).stop();
    return;
  }
  if (process.platform === "win32") {
    await deleteWindowsComputerUpgradeTask(requestId, options.windowsTaskRunner);
  }
}

/** Removes the one-shot Scheduled Task for a completed Windows remote upgrade. */
export async function deleteWindowsComputerUpgradeTask(
  requestId: string,
  run: WindowsUpgradeTaskRunner = runSchtasks,
): Promise<void> {
  const code = await run([
    "schtasks.exe",
    "/Delete",
    "/TN",
    computerUpgradeTaskName(requestId),
    "/F",
  ]);
  if (code !== 0) throw new Error("could not remove the Computer upgrade Scheduled Task");
}
