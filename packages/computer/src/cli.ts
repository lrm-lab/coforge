#!/usr/bin/env bun

import { Command, CommanderError } from "commander";
import { homedir } from "os";

import { resolveComputerInstallDirectory } from "@lrm/coforge-daemon";
import { CliError, setupError } from "./errors";
import { resolveComputerStateDirectory, resolveDaemonSocketPath } from "./paths";
import { COFORGE_RELEASE_FEED_URL, COFORGE_SERVER_URL } from "./release-channel";
import { FileComputerConfig } from "./local-config";
import { resolveComputerConfigDirectory } from "./paths";
import { currentComputerPlatform } from "./platform";
import { COFORGE_DAEMON_SERVER_URL, runMachineSupervisor } from "@lrm/coforge-daemon";
import { isValidComputerWorkspaceSlug } from "#src/workspace/workspace-slug";
import { writeCliFailure } from "#src/cli/failure-output";
import { createLoginCommand, createSetupCommand } from "#src/cli/login-setup-commands";
import { createCommand, createLogsCommand } from "#src/cli/daemon-commands";
import { createUpdateCommand } from "#src/cli/update-command";
import { describeUpgradePlan, planUpgrade } from "#src/cli/upgrade-plan";
import { configureComputerLogger } from "#src/logging/computer-logger";
import { COFORGE_COMPUTER_VERSION as VERSION } from "./version";
import { createStatusPorts } from "#src/status/create-status-ports";
import { createStatusCommand, type StatusCommand } from "#src/status/status-command";
import { createDoctorCommand, type DoctorCommand } from "#src/doctor/doctor-command";
import { registerDiagnosticCommands } from "#src/cli/diagnostic-commands";
import {
  createLogoutCommand,
  registerLogoutCommand,
  type LogoutCommand,
} from "#src/cli/logout-command";
import { prepareContainerBinding } from "#src/host/container-binding";
import { runHostProcess } from "#src/host/run-host";

export interface LoginCommand {
  run(serverUrl: string, options: { json: boolean }): Promise<void>;
}

export interface SetupCommand {
  run(workspaceSlug: string | undefined, options: { json: boolean }): Promise<void>;
}

/** `--allow-downgrade`: the target may be older than the installed version. */
export interface UpdateOptions {
  allowDowngrade: boolean;
}

export interface UpdateCommand {
  resolveVersion(selector: string): Promise<string>;
  getCurrentVersion(): Promise<string | null>;
  install(version: string, options: UpdateOptions): Promise<void>;
  upgrade(version: string, options: UpdateOptions): Promise<void>;
  /** Resolves to the installer's exit status. */
  recover(): Promise<number>;
}

export interface DaemonCommand {
  start(workspace?: string): Promise<void>;
  stop(workspace?: string): Promise<void>;
  restart(workspace?: string): Promise<void>;
  /** Restarts the Coordinator process itself (not a Workspace runtime) through the platform
   * host, holding runners first. See `coforge-computer restart --supervisor`. */
  restartSupervisor?(): Promise<void>;
}

export interface LogsCommand {
  follow(): Promise<void>;
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
  registerLogoutCommand(program, dependencies.logout, (value) => {
    json = value;
  });
  program
    .command("setup")
    .alias("attach")
    .description("Attach this Computer to the selected Workspace and start its Daemon.")
    .option(
      "--workspace <slug>",
      "Workspace slug to join (falls back to COFORGE_SETUP_INTENT when omitted)",
    )
    .option("--json", "write one stable JSON result to stdout")
    .action((options: { json?: boolean; workspace?: string }) => {
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
      return dependencies.setup.run(workspaceSlug, { json });
    });
  program
    .command("install")
    .description("Install one verified Computer version for the current user.")
    .option("--version <selector>", "latest|<version>", "latest")
    .option("--allow-downgrade", "Allow --version to be older than the installed Computer")
    .action((options: { version: string; allowDowngrade?: boolean }) =>
      requireUpdater(dependencies).install(options.version, {
        allowDowngrade: options.allowDowngrade === true,
      }),
    );
  program
    .command("upgrade")
    .description(
      "Atomically move to one verified Computer version, newer or older (an older --version needs --allow-downgrade).",
    )
    .option("--version <selector>", "latest|<version>", "latest")
    .option("--allow-downgrade", "Allow --version to be older than the installed Computer")
    .option(
      "--dry-run",
      "Show the version this would move to, and whether it would be refused, without changing anything",
    )
    .action(async (options: { version: string; allowDowngrade?: boolean; dryRun?: boolean }) => {
      const allowDowngrade = options.allowDowngrade === true;
      const updater = requireUpdater(dependencies);
      const target = await updater.resolveVersion(options.version);
      if (options.dryRun) {
        const report = describeUpgradePlan(
          planUpgrade(await updater.getCurrentVersion(), target, allowDowngrade),
        );
        for (const line of report.lines) io.stdout(line);
        exitCode = report.exitCode;
        return;
      }
      if ((await updater.getCurrentVersion()) === target) {
        io.stdout(`Already up to date: ${target}`);
        return;
      }
      const answer = (io.prompt ?? globalThis.prompt)(
        `Upgrade CoForge Computer to ${target}? [y/N] `,
      );
      if (!/^(y|yes)$/i.test(answer?.trim() ?? "")) {
        io.stdout("Upgrade cancelled.");
        return;
      }
      return updater.upgrade(target, { allowDowngrade });
    });
  program
    .command("recover")
    .description("Finish an upgrade that did not complete.")
    .action(async () => {
      exitCode = await requireUpdater(dependencies).recover();
    });
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

/** `--workspace` wins when the user supplies it explicitly; the setup-intent environment
 * variable is a fallback source, not a second required input. A blank `--workspace ""`
 * counts as supplied (and is later rejected as invalid) rather than falling through. */
function resolveSetupWorkspace(cliWorkspace: string | undefined): string | undefined {
  return cliWorkspace !== undefined ? cliWorkspace : readSetupIntentWorkspace();
}

/** e2e/automation bootstrap bypass: production install flows never set this env var, so the
 * normal path is the explicit `--workspace <slug>` flag above. */
function readSetupIntentWorkspace(): string | undefined {
  const raw = process.env.COFORGE_SETUP_INTENT;
  if (!raw) return undefined;
  try {
    const intent: unknown = JSON.parse(raw);
    if (typeof intent === "object" && intent !== null && "workspaceSlug" in intent) {
      const slug = (intent as { workspaceSlug?: unknown }).workspaceSlug;
      return typeof slug === "string" && slug.length > 0 ? slug : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function requireUpdater(dependencies: CliDependencies): UpdateCommand {
  if (!dependencies.updater) throw new Error("Updater is unavailable in this build");
  return dependencies.updater;
}

function requireDaemon(dependencies: CliDependencies): DaemonCommand {
  if (!dependencies.daemon) throw new Error("Daemon coordinator is unavailable in this build");
  return dependencies.daemon;
}

function requireLogs(dependencies: CliDependencies): LogsCommand {
  if (!dependencies.logs) throw new Error("Computer logs are unavailable in this build");
  return dependencies.logs;
}

function requireForeground(dependencies: CliDependencies): ForegroundCommand {
  if (!dependencies.foreground)
    throw new Error("Foreground supervisor is unavailable in this build");
  return dependencies.foreground;
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

export async function runComputer(): Promise<void> {
  const io = {
    stdout: (line: string) => console.log(line),
    stderr: (line: string) => console.error(line),
  };
  const computerDirectory = resolveComputerConfigDirectory({
    platform: process.platform,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const config = new FileComputerConfig(computerDirectory);
  const platform = currentComputerPlatform();
  const stateDirectory = resolveComputerStateDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
    environment: process.env,
  });
  const installDirectory = resolveComputerInstallDirectory({
    platform: platform.os,
    homeDirectory: homedir(),
  });
  const logging = await configureComputerLogger({
    dataDirectory: computerDirectory,
    version: VERSION,
  });
  try {
    process.exitCode = await runCli(
      Bun.argv.slice(2),
      {
        login: createLoginCommand(io, config),
        logout: createLogoutCommand(io),
        setup: createSetupCommand(io, config),
        updater: createUpdateCommand(io),
        daemon: createCommand(
          platform.os,
          installDirectory,
          stateDirectory,
          COFORGE_SERVER_URL,
          config,
          logging.logger,
          io,
        ),
        logs: createLogsCommand(computerDirectory, io),
        status: createStatusCommand(
          io,
          createStatusPorts({
            platform: platform.os,
            installDirectory,
            stateDirectory,
            registrations: config,
            releaseFeedUrl: COFORGE_RELEASE_FEED_URL,
            serverUrl: COFORGE_SERVER_URL,
          }),
        ),
        doctor: createDoctorCommand(
          io,
          createStatusPorts({
            platform: platform.os,
            installDirectory,
            stateDirectory,
            registrations: config,
            releaseFeedUrl: COFORGE_RELEASE_FEED_URL,
            serverUrl: COFORGE_SERVER_URL,
          }),
        ),
        foreground: {
          run: async () => {
            await prepareContainerBinding(process.env, stateDirectory, COFORGE_DAEMON_SERVER_URL);
            await runMachineSupervisor([
              "--socket",
              resolveDaemonSocketPath({ platform: platform.os, stateDirectory }),
              "--state-directory",
              stateDirectory,
            ]);
          },
        },
        host: { run: runHostProcess },
      },
      io,
    );
  } finally {
    await logging.close();
  }
}
