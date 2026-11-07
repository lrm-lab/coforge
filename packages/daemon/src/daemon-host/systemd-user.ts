import { join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { nativeCommandDiagnostic, type NativeCommandResult } from "#src/platform/native-command";
import { LocalDaemonLauncher } from "./launcher";
import type {
  CoordinatorServiceRegistrar,
  DaemonLauncher,
  DaemonServiceDefinition,
  DaemonStarted,
  DaemonWorkspaceConfig,
  LocalDaemonLauncherOptions,
} from "./launcher";
import {
  clearSupervisorRecord,
  describeSupervisorUnreachable,
  inspectSupervisor,
  runSystemctl,
  type SupervisorRecord,
  type SystemctlRunner,
} from "./external-supervisor";
import { COORDINATOR_SERVICE } from "./service-identity";

type CommandRunner = (command: string[]) => Promise<NativeCommandResult>;

export class SystemdUserDaemonHost implements DaemonLauncher {
  readonly #unitPath: string;
  readonly #run: CommandRunner;
  readonly #registrar: CoordinatorServiceRegistrar;
  readonly #local: LocalDaemonLauncher;
  readonly #unit: string;
  readonly #stateDirectory: string;
  readonly #supervisorSystemctl: SystemctlRunner;

  constructor(options: {
    homeDirectory: string;
    executablePath: string;
    socketPath: string;
    stateDirectory?: string;
    serverUrl?: string;
    daemonConnectionEndpoint?: string;
    serviceName?: string;
    runtimeHomeDirectory?: string;
    /** Registers and starts the unit when systemd does not know it. */
    registrar: CoordinatorServiceRegistrar;
    run?: CommandRunner;
    /** Runs `systemctl` for the externally supervised unit (task #538); tests inject it. */
    supervisorSystemctl?: SystemctlRunner;
    connect?: LocalDaemonLauncherOptions["connect"];
  }) {
    const serviceName = options.serviceName ?? COORDINATOR_SERVICE.systemdUserUnit;
    if (!isValidServiceName(serviceName)) throw new Error("invalid systemd user service name");
    this.#unitPath = join(options.homeDirectory, ".config", "systemd", "user", serviceName);
    this.#run = options.run ?? runCommand;
    this.#registrar = options.registrar;
    this.#unit = systemdUserUnit(
      options.executablePath,
      options.socketPath,
      options.stateDirectory,
      options.daemonConnectionEndpoint,
      options.runtimeHomeDirectory,
    );
    this.#serviceName = serviceName;
    this.#stateDirectory =
      options.stateDirectory ?? join(options.homeDirectory, ".coforge", "daemon");
    this.#supervisorSystemctl = options.supervisorSystemctl ?? runSystemctl;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory ?? join(options.homeDirectory, ".coforge", "daemon"),
      serverUrl: options.serverUrl,
      connect: options.connect,
    });
  }

  readonly #serviceName: string;

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  /** The unit the installer registers for this host, rendered from the host's own inputs. */
  serviceDefinition(): DaemonServiceDefinition {
    return { manager: "systemd-user", contents: this.#unit, path: this.#unitPath };
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<DaemonStarted> {
    await this.ensureRunning();
    return this.#local.ensureStarted(config);
  }

  async ensureRunning(): Promise<void> {
    // A Computer already answering the local handshake (a `foreground` the person runs) is used
    // as it is: nothing is started or registered beside it (task #538).
    if (await this.#local.isRunning()) return;
    const supervised = await this.#supervisedUnit();
    if (supervised) await this.#supervisorVerb(supervised, "start");
    else if (await this.#unregistered()) await this.#registrar.registerAndStart();
    else await this.#systemctl("start");
    await this.#local.ensureRunning();
  }

  isRunning(): Promise<boolean> {
    return this.#local.isRunning();
  }

  command(
    operation: "start" | "stop" | "restart" | "detach",
    workspaceId?: string,
    detachTarget?: { computerId: string; serverHttpUrl: string },
  ): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.command(operation, workspaceId, detachTarget);
  }

  computerUpgrade(requestId: string, expectedVersion: string): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.control("computer_upgrade", undefined, requestId, expectedVersion);
  }

  async stop(): Promise<void> {
    await this.#systemctl("stop");
  }

  /** Throws when systemd reports that it has no such unit (`LoadState=not-found`), as a
   * foreground, externally supervised Computer never installed one. `restart()` would otherwise
   * ask the registrar for a second Coordinator beside the supervised one. An answer that is not
   * `not-found`, or none (no user bus), is left to the `restart()` that follows, which reports
   * systemd's own reason. */
  async assertRestartable(): Promise<void> {
    if (await this.#supervisedUnit()) return;
    if (await this.#unregistered())
      throw new Error(`systemd has no ${this.#serviceName} unit (LoadState=not-found).`);
  }

  /**
   * The in-place replacement `coforge-computer restart --supervisor` uses to restart the
   * Coordinator process itself (not a Workspace runtime). `reset-failed` clears any earlier
   * failed-state latch a previous crash may have left on the unit - its own exit code is
   * ignored, since there is usually nothing to reset - so a stale failure never blocks this
   * restart; `restart` then does the actual stop-and-start in one systemd transaction. A unit
   * systemd does not know is registered and started by the `registrar` instead.
   */
  async restart(): Promise<void> {
    const supervised = await this.#supervisedUnit();
    if (supervised) {
      await this.#supervisorVerb(supervised, "reset-failed").catch(() => undefined);
      await this.#supervisorVerb(supervised, "restart");
    } else if (await this.#unregistered()) {
      await this.#registrar.registerAndStart();
    } else {
      await this.#run(["systemctl", "--user", "reset-failed", this.#serviceName]);
      await this.#systemctl("restart");
    }
    await this.#local.ensureRunning();
  }

  /** The externally supervised unit recorded by a `foreground` Computer, when systemd still
   * knows it: its start and restart go to that unit and never to a second service beside it.
   * A recorded unit systemd has forgotten is cleared and the Computer manages itself again; one
   * `systemctl` cannot be asked about is an error naming what the person can do (task #538). */
  async #supervisedUnit(): Promise<SupervisorRecord | null> {
    const view = await inspectSupervisor(this.#stateDirectory, {
      systemctl: this.#supervisorSystemctl,
    });
    if (!view) return null;
    if (!view.reachable)
      throw new Error(describeSupervisorUnreachable(view.record, "systemctl did not answer"));
    if (view.unitLoaded) return view.record;
    await clearSupervisorRecord(this.#stateDirectory);
    return null;
  }

  async #supervisorVerb(
    record: SupervisorRecord,
    verb: "start" | "restart" | "reset-failed",
  ): Promise<void> {
    const result = await this.#supervisorSystemctl(record.scope, [verb, record.unit]);
    if (result.code !== 0)
      throw new Error(
        describeSupervisorUnreachable(
          record,
          `\`systemctl ${verb} ${record.unit}\` exited ${result.code ?? "without a code"}: ${nativeCommandDiagnostic(result.stderr) || result.stdout.trim() || "no output"}`,
        ),
      );
  }

  /** True only when systemd answers that it has no such unit (`LoadState=not-found`). Any other
   * answer, or none (no user bus, say), is left to the `systemctl` verb that follows, which
   * reports systemd's own reason. */
  async #unregistered(): Promise<boolean> {
    const result = await this.#run([
      "systemctl",
      "--user",
      "show",
      "--property=LoadState",
      "--value",
      this.#serviceName,
    ]);
    return result.code === 0 && result.stdout.trim() === "not-found";
  }

  /** Runs one `systemctl --user` verb against this Daemon's unit, turning a refusal into the
   * reason systemd itself printed. Every caller below goes through here: before this, a failure
   * anywhere in the unit lifecycle surfaced as one fixed sentence about foreground supervision,
   * which left a person with nothing to act on when the real cause was something else entirely -
   * most often a `su`/`sudo` shell that has no user bus at all. */
  async #systemctl(verb: "start" | "stop" | "restart"): Promise<void> {
    const result = await this.#run(["systemctl", "--user", verb, this.#serviceName]);
    if (result.code !== 0) throw systemctlFailure(verb, this.#serviceName, result);
  }
}

export function systemdUserUnit(
  executablePath: string,
  socketPath: string,
  stateDirectory?: string,
  daemonConnectionEndpoint?: string,
  runtimeHomeDirectory?: string,
): string {
  return `[Unit]
Description=CoForge Daemon

[Service]
${runtimeHomeDirectory ? `Environment=HOME=${systemdEscape(runtimeHomeDirectory)}\n` : ""}${daemonConnectionEndpoint ? `Environment=COFORGE_DAEMON_CONNECTION_ENDPOINT=${systemdEscape(daemonConnectionEndpoint)}\n` : ""}ExecStart=${systemdEscape(executablePath)} __daemon --socket ${systemdEscape(socketPath)}${stateDirectory ? ` --state-directory ${systemdEscape(stateDirectory)}` : ""}
Restart=on-failure
RestartSec=2
KillMode=mixed

[Install]
WantedBy=default.target
`;
}

/**
 * What a person should do next, chosen from what systemd refused with. `systemctl --user` needs
 * this user's own session bus, so it fails outright in a `su` or `sudo` shell - the session that
 * produced the 2026-09-20 upgrade failure on a shared Linux host - and that failure looks nothing
 * like a Daemon that is genuinely supervised from the foreground.
 */
function systemctlRemedy(diagnostic: string, unit: string): string {
  if (/failed to connect to bus|no medium found/i.test(diagnostic))
    return `This shell has no systemd user session, which a \`su\` or \`sudo\` shell never gets. Open this user's own login session - \`ssh <user>@<host>\`, or \`machinectl shell <user>@\` - and run the command there. If that user has no login session on this machine, run \`loginctl enable-linger <user>\` once and retry from that user's session, or run \`coforge-computer foreground\` under a supervisor of your own.`;
  if (/not loaded|not found|no such unit/i.test(diagnostic))
    return "No CoForge Daemon user service is installed on this Computer. Install and start one with `coforge-computer start`, or control the Daemon through the external supervisor that runs it.";
  return `Check \`systemctl --user status ${unit}\` for the unit's own account of it.`;
}

function systemctlFailure(verb: string, unit: string, result: NativeCommandResult): Error {
  const diagnostic = nativeCommandDiagnostic(result.stderr);
  const attempt = `\`systemctl --user ${verb} ${unit}\` failed (${result.code})`;
  const reported = diagnostic
    ? `${attempt}: ${/[.!?]$/.test(diagnostic) ? diagnostic : `${diagnostic}.`}`
    : `${attempt}.`;
  return new Error(`${reported} ${systemctlRemedy(diagnostic, unit)}`);
}

async function runCommand(command: string[]): Promise<NativeCommandResult> {
  const child = Bun.spawn(command, {
    env: { ...process.env, LC_ALL: "C" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

function systemdEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function isValidServiceName(value: string): boolean {
  return value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9_.@:-]*\.service$/.test(value);
}
