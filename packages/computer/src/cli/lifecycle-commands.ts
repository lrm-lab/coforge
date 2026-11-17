import type { Command } from "commander";

import type { DaemonCommand, ForegroundCommand, LogsCommand } from "#src/cli";
import type { DetachOutcome } from "#src/detach/detach";
import { CliError } from "#src/errors";
import { DEFAULT_LOG_LINES, type LogSource } from "#src/logging/computer-logs";

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
    .description("Stop the Computer: its Daemon and every Workspace runtime under it.")
    .option(
      "--workspace <slug-or-id>",
      "Stop only this local Workspace runtime, leaving the Daemon up",
    )
    .option("--json", "write one stable JSON result to stdout")
    .option("--jobs", "Also stop running Agent background jobs (coforge proc)", false)
    .action((options: { workspace?: string; json?: boolean; jobs?: boolean }) => {
      setJson(options.json ?? false);
      return requireDaemon(dependencies).stop(options.workspace, {
        json: options.json ?? false,
        jobs: options.jobs ?? false,
      });
    });
  program
    .command("detach")
    .description("Detach this Computer from a Workspace: stop its Daemon and remove its key.")
    .option("--workspace <slug-or-id>", "Detach this local Workspace binding")
    .option("--json", "write one stable JSON result to stdout")
    .action(async (options: { workspace?: string; json?: boolean }) => {
      setJson(options.json ?? false);
      const outcome = await requireDaemon(dependencies).detach(options.workspace);
      if (options.json) {
        writeDetachedOutcomeJson(outcome, io);
        return;
      }
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
    .description("Print a bounded tail of the Computer, supervisor, or Workspace log.")
    .option(
      "-n, --lines <count>",
      "Number of most recent log lines to print",
      String(DEFAULT_LOG_LINES),
    )
    .option("-f, --follow", "Follow new log lines after printing the initial tail", false)
    .option("--supervisor", "Read the Computer supervisor (Coordinator) daemon log")
    .option("--workspace <slug-or-id>", "Read a local Workspace runtime's daemon log")
    .option("--computer", "Read the Computer CLI log")
    .action(
      (options: {
        lines: string;
        follow?: boolean;
        supervisor?: boolean;
        workspace?: string;
        computer?: boolean;
      }) => {
        const selected =
          Number(Boolean(options.supervisor)) +
          Number(options.workspace !== undefined) +
          Number(Boolean(options.computer));
        if (selected > 1) {
          throw new CliError(
            "LOGS_CONFLICTING_SOURCE",
            "--supervisor, --workspace, and --computer cannot be used together.",
            "Choose one log source: --supervisor, --workspace <slug>, or --computer.",
          );
        }
        const trimmedLines = options.lines.trim();
        const lines = Number(trimmedLines);
        if (!/^\d+$/.test(trimmedLines) || !Number.isSafeInteger(lines) || lines < 1) {
          throw new CliError(
            "LOGS_INVALID_LINES",
            `Invalid --lines value '${options.lines}': expected a positive integer.`,
            "Pass a positive line count, for example `coforge-computer logs --lines 200`.",
          );
        }
        const source: LogSource = options.supervisor
          ? "supervisor"
          : options.workspace !== undefined
            ? { workspace: options.workspace }
            : "computer";
        const logs = requireLogs(dependencies);
        if (logs.run) {
          return logs.run({ lines, follow: Boolean(options.follow), source });
        }
        if (logs.follow) return logs.follow();
        throw new Error("Computer logs are unavailable in this build");
      },
    );
}

/**
 * `detach --json`: one object, no prose. `ok` says the command finished rather than that the
 * machine left — `stop --json` answers `{ok:true,stopped:false}` for the same distinction — and
 * `detached`/`kind` carry what actually happened, so a caller that wanted a detach is not
 * misled by `not_attached`, a server that never confirmed, a supervisor that never bound it, or
 * a key the server had already revoked. That last one leaves only the local half behind, so a
 * re-attach under a newer key may still be live: `DetachOutcome` calls it `key_revoked` rather
 * than `detached`, and `detached` follows that (task #696).
 */
function writeDetachedOutcomeJson(
  outcome: DetachOutcome,
  io: { stdout: (line: string) => void },
): void {
  io.stdout(
    JSON.stringify({
      ok: true,
      detached: outcome.kind === "detached",
      kind: outcome.kind,
      ...(outcome.kind === "not_attached" ? {} : { workspaceSlug: outcome.workspaceSlug }),
    }),
  );
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
