// The install and upgrade command wiring behind the Computer updater.

import { ComputerUpdater } from "#src/updater";
import {
  resolveUpgradeRunnerPaths,
  runInstallerRepair,
  runUpgradeOperation,
} from "#src/release/upgrade-runner";
import { nextUpgradeCommandHint, reportStoppedWorkspaces } from "./upgrade-output";
import { createLocalUpgradeOperation } from "#src/release/upgrade-operation";
import { COFORGE_RELEASE_FEED_URL } from "#src/release-channel";
import { runInstallationSource } from "#src/release/installation-source";
import { runDetachedUpgrade } from "#src/release/detached-upgrade";
import { UpgradeFailedError } from "#src/release/upgrade-receipt";
import type { UpgradeResult } from "@lrm/coforge-sdk/internal/upgrade-receipt";
import type { UpdateCommand, UpdateOptions } from "#src/cli";

export function createUpdateCommand(
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
  },
  /** Tests inject the two runners; production uses the platform launcher and the installer. */
  dependencies: {
    detachedUpgrade?: typeof runDetachedUpgrade;
    inPlaceUpgrade?: typeof runUpgradeOperation;
  } = {},
): UpdateCommand {
  const { installRoot, target } = resolveUpgradeRunnerPaths();
  const updater = new ComputerUpdater({ installRoot });
  /**
   * Moves the Computer through an OS one-shot job and waits for its receipt: the operation is
   * outside this process, so stopping this process (by the upgrade, by an Agent's session, or by
   * Ctrl-C) cannot leave the machine half-switched. An explicit downgrade stays in place — a
   * remote operation never carries `--allow-downgrade` — and is a deliberate operator action from
   * a terminal, where the in-place guard allows it.
   */
  const move = async (version: string, options: UpdateOptions): Promise<UpgradeResult> => {
    if (options.allowDowngrade)
      return await (dependencies.inPlaceUpgrade ?? runUpgradeOperation)(
        createLocalUpgradeOperation(version, options),
      );
    const outcome = await (dependencies.detachedUpgrade ?? runDetachedUpgrade)({
      version,
      installRoot,
      // The job's own progress lines are diagnostics: they belong on stderr, never on the
      // command's stdout, which a `--json` caller reads.
      onLine: (line) => io.stderr(`${line}\n`),
      onNote: (line) => io.stderr(`${line}\n`),
    });
    if (outcome.kind === "still-running")
      throw new Error(
        `Upgrade ${outcome.requestId} is still running; check \`coforge-computer status\` for its result.`,
      );
    if (outcome.result.status !== "succeeded")
      throw new UpgradeFailedError(
        outcome.result.error ?? "the upgrade did not complete",
        outcome.result,
      );
    return outcome.result;
  };

  return {
    resolveVersion: (selection) =>
      runInstallationSource({ baseUrl: COFORGE_RELEASE_FEED_URL, target, selection }),
    getCurrentVersion: () => updater.getCurrentVersion(),
    async install(version, options) {
      const result = await move(version, options);
      io.stdout(`CoForge Computer ${result.version ?? version} installed successfully.`);
      reportStoppedWorkspaces(io, result);
    },
    async upgrade(version, options) {
      const current = await updater.getCurrentVersion();
      io.stdout(`==> Updating CoForge Computer${current ? ` from ${current}` : ""} to ${version}`);
      let result: UpgradeResult;
      try {
        result = await move(version, options);
      } catch (error) {
        // The reason is already on stderr from `UpdateError`/`UpgradeFailedError` handling
        // in `runCli`'s catch below; this only adds the next command, never changes what is
        // thrown or its exit code.
        io.stderr(nextUpgradeCommandHint(error));
        throw error;
      }
      io.stdout(`CoForge Computer ${result.version ?? version} updated successfully.`);
      reportStoppedWorkspaces(io, result);
    },
    repair: () => runInstallerRepair(),
  };
}
