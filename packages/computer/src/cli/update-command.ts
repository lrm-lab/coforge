// The install, upgrade, and recover command wiring behind the Computer updater.

import { ComputerUpdater } from "#src/updater";
import {
  resolveUpgradeRunnerPaths,
  runInstallerRecovery,
  runUpgradeOperation,
} from "#src/release/upgrade-runner";
import { nextUpgradeCommandHint, reportStoppedWorkspaces } from "./upgrade-output";
import { createLocalUpgradeOperation } from "#src/release/upgrade-operation";
import { COFORGE_RELEASE_FEED_URL } from "#src/release-channel";
import { runInstallationSource } from "#src/release/installation-source";
import type { UpdateCommand, UpdateOptions } from "#src/cli";

export function createUpdateCommand(io: {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}): UpdateCommand {
  const { installRoot, target } = resolveUpgradeRunnerPaths();
  const updater = new ComputerUpdater({ installRoot });
  const run = (selection: string, options: UpdateOptions) =>
    runUpgradeOperation(createLocalUpgradeOperation(selection, options));
  return {
    resolveVersion: (selection) =>
      runInstallationSource({ baseUrl: COFORGE_RELEASE_FEED_URL, target, selection }),
    getCurrentVersion: () => updater.getCurrentVersion(),
    async install(version, options) {
      const result = await run(version, options);
      io.stdout(`CoForge Computer ${result.version} installed successfully.`);
      reportStoppedWorkspaces(io, result);
    },
    async upgrade(version, options) {
      const current = await updater.getCurrentVersion();
      io.stdout(`==> Updating CoForge Computer${current ? ` from ${current}` : ""} to ${version}`);
      let result: Awaited<ReturnType<typeof run>>;
      try {
        result = await run(version, options);
      } catch (error) {
        // The reason is already on stderr from `UpdateError`/`UpgradeFailedError` handling
        // in `runCli`'s catch below; this only adds the next command, never changes what is
        // thrown or its exit code.
        io.stderr(nextUpgradeCommandHint(error));
        throw error;
      }
      io.stdout(`CoForge Computer ${result.version} updated successfully.`);
      reportStoppedWorkspaces(io, result);
    },
    recover: () => runInstallerRecovery(),
  };
}
