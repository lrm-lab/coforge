import { readUpgradeReceipt, resolveComputerInstallDirectory } from "@lrm/coforge-daemon";
import type { UpgradeResult } from "@lrm/coforge-sdk/internal/upgrade-receipt";

import { currentComputerPlatform } from "#src/platform";
import { COFORGE_RELEASE_FEED_URL } from "#src/release-channel";
import { UpdateError } from "#src/updater";
import {
  obtainInstaller,
  type InstallerLaunchOptions,
  type VerifiedInstaller,
} from "./installer-launch";
import type { UpgradeOperation } from "./upgrade-operation";
import { UpgradeFailedError, writeFallbackReceipt } from "./upgrade-receipt";
import { thrownMessage } from "@lrm/coforge-sdk/internal";

/** How one run of the installer is started. Stdin is always ignored. */
export type InstallerSpawn = {
  path: string;
  args: string[];
  stdin: "ignore";
  stdout: "inherit" | "ignore";
  stderr: "inherit" | "pipe";
};

export type InstallerRun = { exitCode: number; stderr: string };

export type UpgradeRunnerOptions = {
  /** The install root: `<install root>/upgrade-results` holds the receipts. */
  installRoot: string;
  /** This machine's release target, e.g. `linux-x64`. */
  target: string;
  feedUrl: string;
  obtainInstaller: (options: InstallerLaunchOptions) => Promise<VerifiedInstaller>;
  spawnInstaller: (spawn: InstallerSpawn) => Promise<InstallerRun>;
  /** Where a CLI operation echoes what the installer wrote to stderr. */
  writeStderr: (text: string) => void;
};

/** The installation and target this machine resolves from `os.homedir()`: HOME on POSIX (else the
 * account's passwd entry), USERPROFILE on Windows (else the profile directory). The installer
 * follows the same rule; see crates/installer/contract/paths.json. */
export function resolveUpgradeRunnerPaths(): { installRoot: string; target: string } {
  return {
    installRoot: resolveComputerInstallDirectory(),
    target: currentComputerPlatform().releaseTarget,
  };
}

/** Runs the installer's `upgrade` through the given dependencies, for the real CLI and the tests. */
export function defaultUpgradeRunnerOptions(): UpgradeRunnerOptions {
  return {
    ...resolveUpgradeRunnerPaths(),
    feedUrl: COFORGE_RELEASE_FEED_URL,
    obtainInstaller,
    spawnInstaller: defaultSpawnInstaller,
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  };
}

export async function defaultSpawnInstaller(spawn: InstallerSpawn): Promise<InstallerRun> {
  const child = Bun.spawn({
    cmd: [spawn.path, ...spawn.args],
    stdin: spawn.stdin,
    stdout: spawn.stdout,
    stderr: spawn.stderr,
    windowsHide: true,
  });
  const [stderr, exitCode] = await Promise.all([
    spawn.stderr === "pipe" ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);
  return { exitCode, stderr };
}

/**
 * Runs one upgrade through the separately released `coforge-installer`. The installer owns the
 * transaction and writes the receipt; this function obtains it, runs it, and turns its receipt into
 * the result. When the installer leaves no receipt, or cannot be obtained, a failed receipt is
 * written so a remote operation can still be settled. An existing receipt is never replaced.
 */
export async function runUpgradeOperation(
  operation: UpgradeOperation,
  overrides: Partial<UpgradeRunnerOptions> = {},
): Promise<UpgradeResult> {
  const options = { ...defaultUpgradeRunnerOptions(), ...overrides };
  await assertOutsideManagedSupervisor();
  const { requestId, origin, selection, allowDowngrade } = operation;
  const launch = {
    feedUrl: options.feedUrl,
    target: options.target,
    installRoot: options.installRoot,
  };

  let installer: VerifiedInstaller;
  try {
    installer = await options.obtainInstaller(launch);
  } catch (error) {
    if (!(error instanceof UpdateError)) throw error;
    return conclude(
      await settle(options, requestId, { error: error.message, errorCode: error.code }),
    );
  }

  let run: InstallerRun;
  try {
    run = await options.spawnInstaller({
      path: installer.path,
      args: [
        "upgrade",
        "--request-id",
        requestId,
        "--version",
        selection,
        "--caller-pid",
        String(process.pid),
        ...(allowDowngrade ? ["--allow-downgrade"] : []),
      ],
      stdin: "ignore",
      stdout: origin === "remote" ? "ignore" : "inherit",
      stderr: "pipe",
    });
  } catch (error) {
    return conclude(
      await settle(options, requestId, {
        error: thrownMessage(error),
      }),
    );
  }
  if (origin === "cli" && run.stderr) options.writeStderr(run.stderr);
  return conclude(
    await settle(options, requestId, {
      error: lastLine(run.stderr) ?? `coforge-installer exited ${run.exitCode} without a receipt`,
    }),
  );
}

/**
 * Finishes an upgrade the installer left unresolved, through the installer's own `recover`
 * command, with the terminal attached. Resolves to the installer's exit status.
 */
export async function runInstallerRecovery(
  overrides: Partial<UpgradeRunnerOptions> = {},
): Promise<number> {
  const options = { ...defaultUpgradeRunnerOptions(), ...overrides };
  await assertOutsideManagedSupervisor();
  const installer = await options.obtainInstaller({
    feedUrl: options.feedUrl,
    target: options.target,
    installRoot: options.installRoot,
  });
  const run = await options.spawnInstaller({
    path: installer.path,
    args: ["recover", "--caller-pid", String(process.pid)],
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return run.exitCode;
}

/** The receipt the operation ends with: the one the installer wrote, or a failed one written now
 * when it left none. Whatever is on disk afterwards is what gets read back. */
async function settle(
  options: UpgradeRunnerOptions,
  requestId: string,
  failure: { error: string; errorCode?: string },
): Promise<UpgradeResult> {
  const existing = await readReceipt(options.installRoot, requestId);
  if (existing) return existing;
  await writeFallbackReceipt(options.installRoot, {
    schema_version: 1,
    request_id: requestId,
    operation: "upgrade",
    status: "failed",
    error: failure.error,
    ...(failure.errorCode ? { errorCode: failure.errorCode } : {}),
  });
  const written = await readReceipt(options.installRoot, requestId);
  if (!written) throw new Error(`upgrade receipt for ${requestId} could not be read back`);
  return written;
}

function conclude(result: UpgradeResult): UpgradeResult {
  if (result.status === "succeeded") return result;
  throw new UpgradeFailedError(result.error ?? "upgrade failed", result);
}

/** Reads one operation's receipt, if the installer or the fallback wrote one. */
async function readReceipt(
  installRoot: string,
  requestId: string,
): Promise<UpgradeResult | undefined> {
  return (await readUpgradeReceipt(installRoot, requestId))?.result;
}

function lastLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

/** The installer's stop/start logic can only be run from outside the managed supervisor unit: on
 * Linux, every process in `coforge-daemon.service` shares its stop scope, so stopping the service
 * would terminate the process that is running the upgrade. */
async function assertOutsideManagedSupervisor(): Promise<void> {
  if (process.platform !== "linux") return;
  const cgroup = await Bun.file("/proc/self/cgroup")
    .text()
    .catch(() => "");
  if (cgroup.includes("coforge-daemon.service"))
    throw new Error(
      "Upgrade must be started from a normal terminal, not from inside coforge-daemon.service, because stopping the service would terminate its coordinator.",
    );
}
