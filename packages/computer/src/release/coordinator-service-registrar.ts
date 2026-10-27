import type { CoordinatorServiceRegistrar } from "@lrm/coforge-daemon";

import {
  defaultUpgradeRunnerOptions,
  lastLine,
  runInstaller,
  type UpgradeRunnerOptions,
} from "./upgrade-runner";

/**
 * Registers and starts the Coordinator service by running the installer's `start`: the installer
 * alone writes the service definition and registers it with the platform manager, and resolves
 * once the manager reports the service running. The Computer only asks. Options default to this
 * machine's install root, release target, and feed, and are resolved when asked, not when built.
 */
export function createCoordinatorServiceRegistrar(
  overrides: Partial<UpgradeRunnerOptions> = {},
): CoordinatorServiceRegistrar {
  return {
    async registerAndStart() {
      const options = { ...defaultUpgradeRunnerOptions(), ...overrides };
      const { run, installer } = await runInstaller(options, ["start"], {
        stdout: "inherit",
        stderr: "pipe",
      });
      if (run.exitCode === 0) return;
      const reason = lastLine(run.stderr) ?? `coforge-installer start exited ${run.exitCode}`;
      // Without a version the installer is the cached copy used while the feed was unreachable,
      // which may predate `start`.
      throw new Error(
        installer.version === undefined
          ? `${reason} (ran the cached installer; connect to the network so the current installer can be fetched)`
          : reason,
      );
    },
  };
}
