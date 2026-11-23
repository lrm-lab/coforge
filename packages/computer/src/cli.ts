#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { setupError } from "./errors";
import { COFORGE_SERVER_URL } from "./release-channel";
import type { ReleaseChannel } from "#src/release/channel-state";
import { isValidComputerWorkspaceSlug } from "#src/workspace/workspace-slug";
import { writeCliFailure } from "#src/cli/failure-output";
import type { DetachOutcome } from "#src/detach/detach";
import { COFORGE_COMPUTER_VERSION as VERSION } from "./version";
import type { StatusCommand } from "#src/status/status-command";
import type { DoctorCommand } from "#src/doctor/doctor-command";
import { registerDiagnosticCommands } from "#src/cli/diagnostic-commands";
import { registerLifecycleCommands } from "#src/cli/lifecycle-commands";
import { registerLogoutCommand, type LogoutCommand } from "#src/cli/logout-command";
import { confirmSetupIdentityChange } from "#src/cli/setup-identity-confirmation";
import { resolveSetupWorkspace } from "#src/cli/setup-workspace";
import { registerChannelCommand, type ChannelCommand } from "#src/cli/release-channel-command";
import { registerUpdateCommands } from "#src/cli/update-command-registration";
import { registerRunnersCommand } from "#src/cli/runners-command";
import type { RunnerCommand } from "#src/runners/runner-command";

export interface LoginCommand {
  run(serverUrl: string, options: { json: boolean }): Promise<void>;
}

export interface SetupCommand {
  run(
    workspaceSlug: string | undefined,
    options: {
      json: boolean;
      oneShot?: boolean;
      machineId?: string;
      fresh?: boolean;
      verbose?: boolean;
      yes?: boolean;
    },
  ): Promise<void>;
}

/** `--allow-downgrade`: the target may be older than the installed version. */
export interface UpdateOptions {
  allowDowngrade: boolean;
  releaseFeedUrl?: string;
  releaseChannel?: string;
}

export interface UpdateCommand {
  resolveVersion(selector: string, options?: { channel?: string }): Promise<string>;
  resolveChannel?(): Promise<ReleaseChannel>;
  resolveFeedUrl?(channel: ReleaseChannel): string;
  getCurrentVersion(): Promise<string | null>;
  install(version: string, options: UpdateOptions): Promise<void>;
  upgrade(version: string, options: UpdateOptions): Promise<void>;
  /** Resolves to the installer's exit status. */
  /** Resolves to the installer's exit status. */
  repair(): Promise<number>;
}

export interface DaemonCommand {
  start(workspace?: string): Promise<void>;
  /** Unscoped, stops the whole Computer through the platform manager; `--workspace` stops one
   * runtime and leaves the Coordinator up. */
  stop(workspace?: string, options?: { json?: boolean; jobs?: boolean }): Promise<void>;
  /** `daemon:detach` (task #417): removes this Workspace's registration once the server
   * confirms the detach; an unconfirmed server answer keeps it and reports so. */
  detach(workspace?: string): Promise<DetachOutcome>;
  restart(workspace?: string, options?: { json?: boolean }): Promise<void>;
  /** Restarts the Coordinator process itself (not a Workspace runtime) through the platform
   * host, holding runners first. See `coforge-computer restart --supervisor`. */
  restartSupervisor?(options?: { json?: boolean }): Promise<void>;
}

import type { LogSource } from "#src/logging/computer-logs";

export interface LogsCommand {
  run?(options?: { lines?: number; follow?: boolean; source?: LogSource }): Promise<void>;
  follow?(): Promise<void>;
}

export interface ForegroundCommand {
  run(): Promise<void>;
}

export interface HostCommand {
  run(options: {
    serverUrl: string;
    token: string;
    nodeKey: string;
    name: string;
    image: string;
    pollIntervalMs: number;
  }): Promise<void>;
}

export type { StatusCommand };
export type { DoctorCommand };

interface CliDependencies {
  login: LoginCommand;
  logout?: LogoutCommand;
  setup: SetupCommand;
  updater?: UpdateCommand;
  daemon?: DaemonCommand;
  logs?: LogsCommand;
  foreground?: ForegroundCommand;
  status?: StatusCommand;
  doctor?: DoctorCommand;
  host?: HostCommand;
  channel?: ChannelCommand;
  runners?: RunnerCommand;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies,
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    prompt?: (question: string) => string | null;
  } = {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  },
): Promise<number> {
  let json = false;
  let loginSelected = false;
  let exitCode = 0;
  let setupSelected = false;
  const program = new Command()
    .name("coforge-computer")
    .description("Connect this machine to CoForge so code agents can run here.")
    .version(VERSION, "-V, --cli-version", "output the Computer CLI version")
    .showHelpAfterError()
    .showSuggestionAfterError()
    .exitOverride();
  program
    .command("login")
    .description("Sign in to CoForge without selecting a Workspace.")
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { json?: boolean }) => {
      loginSelected = true;
      json = options.json ?? false;
      return dependencies.login.run(COFORGE_SERVER_URL, { json });
    });
  registerChannelCommand(program, dependencies.channel);
  registerLogoutCommand(program, dependencies.logout, (value) => {
    json = value;
  });
  program
    .command("attach")
    .description(
      "Attach this Computer to a Workspace by a one-shot approval: open the printed link and confirm the code",
    )
    .option(
      "--workspace <slug>",
      "Workspace slug to join (the approval's token decides when omitted)",
    )
    .option("--json", "write one stable JSON result to stdout")
    .action(async (options: { json?: boolean; workspace?: string }) => {
      setupSelected = true;
      json = options.json ?? false;
      const workspaceSlug = resolveSetupWorkspace(options.workspace);
      if (workspaceSlug !== undefined && !isValidComputerWorkspaceSlug(workspaceSlug)) {
        throw setupError(
          "SETUP_WORKSPACE_INVALID",
          `Workspace slug '${workspaceSlug}' is not valid.`,
          "workspace-lookup",
        );
      }
      return dependencies.setup.run(workspaceSlug, { json, oneShot: true });
    });
  program
    .command("setup")
    .description("Attach this Computer to the selected Workspace and start its Daemon.")
    .option(
      "--workspace <slug>",
      "Workspace slug to join (falls back to COFORGE_SETUP_INTENT when omitted)",
    )
    .option("--json", "write one stable JSON result to stdout")
    .option(
      "--one-shot",
      "Attach without a login on this machine: open the printed link and confirm the code",
    )
    .option("--machine <id>", "Adopt an existing owned Computer by its server id or machine id")
    .option("--fresh", "Create a new Computer identity instead of adopting existing evidence")
    .option("--verbose", "Print the adoption plan and migration evidence")
    .option("-y, --yes", "Apply the adoption or fresh setup plan without prompting")
    .action(
      (options: {
        json?: boolean;
        workspace?: string;
        oneShot?: boolean;
        machine?: string;
        fresh?: boolean;
        verbose?: boolean;
        yes?: boolean;
      }) => {
        setupSelected = true;
        json = options.json ?? false;
        const workspaceSlug = resolveSetupWorkspace(options.workspace);
        if (workspaceSlug !== undefined && !isValidComputerWorkspaceSlug(workspaceSlug)) {
          throw setupError(
            "SETUP_WORKSPACE_INVALID",
            `Workspace slug '${workspaceSlug}' is not valid.`,
            "workspace-lookup",
          );
        }
        if (!confirmSetupIdentityChange(options, json, io)) return;
        return dependencies.setup.run(workspaceSlug, {
          json,
          oneShot: options.oneShot,
          machineId: options.machine,
          fresh: options.fresh,
          verbose: options.verbose,
          yes: options.yes,
        });
      },
    );
  registerUpdateCommands(program, dependencies.updater, io, (value) => {
    exitCode = value;
  });
  program
    .command("repair")
    .description("Re-register a missing or stale service definition, stopping nothing.")
    .action(async () => {
      exitCode = await requireUpdater(dependencies).repair();
    });
  registerLifecycleCommands(
    program,
    {
      daemon: dependencies.daemon,
      logs: dependencies.logs,
      foreground: dependencies.foreground,
    },
    io,
    (value) => {
      json = value;
    },
  );
  registerDiagnosticCommands(
    program,
    { status: dependencies.status, doctor: dependencies.doctor },
    (value) => {
      json = value;
    },
    (value) => {
      exitCode = value;
    },
  );
  registerRunnersCommand(program, dependencies.runners, (value) => {
    json = value;
  });
  program
    .command("host")
    .description("Run the Swarm manager process that places cloud Computer services.")
    .option("--server-url <url>", "CoForge server URL. Defaults to COFORGE_SERVER_URL.")
    .option("--token <token>", "Cluster token. Defaults to COFORGE_CLUSTER_TOKEN.")
    .option(
      "--node-key <key>",
      "Stable key for this manager. Defaults to COFORGE_CLUSTER_NODE_KEY.",
    )
    .option("--name <name>", "Name reported for this cluster. Defaults to COFORGE_CLUSTER_NAME.")
    .option("--image <image>", "Computer image. Defaults to COFORGE_COMPUTER_IMAGE.")
    .option("--poll-interval <ms>", "Milliseconds between claim polls", "5000")
    .action(
      (options: {
        serverUrl?: string;
        token?: string;
        nodeKey?: string;
        name?: string;
        image?: string;
        pollInterval: string;
      }) =>
        requireHost(dependencies).run({
          serverUrl: hostSetting(options.serverUrl, "COFORGE_SERVER_URL"),
          token: hostSetting(options.token, "COFORGE_CLUSTER_TOKEN"),
          nodeKey: hostSetting(options.nodeKey, "COFORGE_CLUSTER_NODE_KEY"),
          name: hostSetting(options.name, "COFORGE_CLUSTER_NAME"),
          image: hostSetting(options.image, "COFORGE_COMPUTER_IMAGE"),
          pollIntervalMs: Number(options.pollInterval),
        }),
    );

  if (args.length === 0) {
    program.outputHelp();
    return 2;
  }
  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      return error.exitCode;
    }
    writeCliFailure(io, error, { json, login: loginSelected, setup: setupSelected });
    return 1;
  }
  return exitCode;
}

function requireUpdater(dependencies: CliDependencies): UpdateCommand {
  if (!dependencies.updater) throw new Error("Updater is unavailable in this build");
  return dependencies.updater;
}

function hostSetting(flag: string | undefined, envName: string): string {
  const value = flag?.trim() || process.env[envName]?.trim() || "";
  if (!value) throw new Error(`host requires ${envName}`);
  return value;
}

function requireHost(dependencies: CliDependencies): HostCommand {
  if (!dependencies.host) throw new Error("Host process is unavailable in this build");
  return dependencies.host;
}
