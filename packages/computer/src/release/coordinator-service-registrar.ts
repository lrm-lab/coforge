import type { CoordinatorServiceRegistrar } from "@lrm/coforge-daemon";

import { defaultUpgradeRunnerOptions, lastLine, type UpgradeRunnerOptions } from "./upgrade-runner";

/** What an installer too old to have a `start` command says (crates/installer/src/args.rs). */
const UNKNOWN_START = /unknown command: start/;

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
      const installer = await options.obtainInstaller({
        feedUrl: options.feedUrl,
        target: options.target,
        installRoot: options.installRoot,
      });
      // `--caller-pid` is this process, the installer's parent, which it verifies and never stops.
      const run = await options.spawnInstaller({
        path: installer.path,
        args: ["start", "--caller-pid", String(process.pid)],
        stdin: "ignore",
        stdout: "inherit",
        stderr: "pipe",
      });
      if (run.exitCode === 0) return;
      const reason = lastLine(run.stderr) ?? `coforge-installer start exited ${run.exitCode}`;
      throw new Error(
        UNKNOWN_START.test(run.stderr)
          ? `${reason}. Connect to the network so the current installer can be fetched.`
          : reason,
      );
    },
  };
}
