import type { Command } from "commander";

import type { DaemonCommand, ForegroundCommand, LogsCommand } from "#src/cli";
import { CliError } from "#src/errors";

/** The commands that start, stop and restart the Computer or one of its Workspace runtimes.
 * Split out of `cli.ts` to keep that module to the parser and the dependency wiring. */
export type LifecycleCommandDependencies = {
  daemon?: DaemonCommand;
  logs?: LogsCommand;
  foreground?: ForegroundCommand;
};

export function registerLifecycleCommands(
  program: Command,
  dependencies: LifecycleCommandDependencies,
  io: { stdout: (line: string) => void },
  setJson: (value: boolean) => void,
): void {
  program
    .command("start")
    .description("Start the Daemon and all configured Daemon Runtimes.")
    .option("--workspace <slug-or-id>", "Affect only this local Workspace binding")
    .action((options: { workspace?: string }) =>
      requireDaemon(dependencies).start(options.workspace),
    );
  program
    .command("stop")
    .description("Stop the Daemon and all Daemon Runtimes.")
    .option("--workspace <slug-or-id>", "Affect only this local Workspace binding")
    .action((options: { workspace?: string }) =>
      requireDaemon(dependencies).stop(options.workspace),
    );
  program
    .command("detach")
    .description("Detach this Computer from a Workspace: stop its Daemon and remove its key.")
    .option("--workspace <slug-or-id>", "Detach this local Workspace binding")
    .option("--json", "write one stable JSON result to stdout")
    .action(async (options: { workspace?: string; json?: boolean }) => {
      setJson(options.json ?? false);
      const outcome = await requireDaemon(dependencies).detach(options.workspace);
      if (outcome.kind === "unconfirmed")
        io.stdout(
          `The server could not confirm detaching '${outcome.workspaceSlug}'; the local registration was kept.`,
        );
      else if (outcome.kind === "not_bound")
        io.stdout(
          `'${outcome.workspaceSlug}' is not bound on this machine's supervisor; the local registration was kept.`,
        );
      else if (outcome.kind === "detached") io.stdout(`Detached '${outcome.workspaceSlug}'.`);
      else if (outcome.kind === "key_revoked")
        io.stdout(
          `The key on this computer has already been revoked; detached '${outcome.workspaceSlug}' locally.`,
        );
      else if (outcome.kind === "not_attached")
        io.stdout("This computer is not attached to that Workspace.");
    });
  program
    .command("restart")
    .description("Restart the Daemon and all configured Daemon Runtimes.")
    .option("--workspace <slug-or-id>", "Affect only this local Workspace binding")
    .option(
      "--supervisor",
      "Restart the Computer supervisor process itself (not a Workspace runtime), through the platform's process manager",
    )
    .action((options: { workspace?: string; supervisor?: boolean }) => {
      if (options.supervisor && options.workspace)
        throw new CliError(
          "RESTART_CONFLICTING_TARGET",
          "--supervisor and --workspace cannot be used together.",
          "Use --supervisor to restart the Computer supervisor itself, or --workspace to restart one Workspace runtime, not both.",
        );
      if (options.supervisor) {
        const daemon = requireDaemon(dependencies);
        if (!daemon.restartSupervisor)
          throw new Error("Supervisor restart is unavailable in this build");
        return daemon.restartSupervisor();
      }
      return requireDaemon(dependencies).restart(options.workspace);
    });
  program
    .command("foreground")
    .description("Run the Daemon supervisor in the foreground for external supervision.")
    .action(() => requireForeground(dependencies).run());
  program
    .command("logs")
    .description("Follow the Computer log, including rotated log files.")
    .action(() => requireLogs(dependencies).follow());
}

function requireDaemon(dependencies: LifecycleCommandDependencies): DaemonCommand {
  if (!dependencies.daemon) throw new Error("Daemon coordinator is unavailable in this build");
  return dependencies.daemon;
}

function requireLogs(dependencies: LifecycleCommandDependencies): LogsCommand {
  if (!dependencies.logs) throw new Error("Computer logs are unavailable in this build");
  return dependencies.logs;
}

function requireForeground(dependencies: LifecycleCommandDependencies): ForegroundCommand {
  if (!dependencies.foreground)
    throw new Error("Foreground supervisor is unavailable in this build");
  return dependencies.foreground;
}
