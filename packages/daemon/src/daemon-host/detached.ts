import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { parseProcStat } from "#src/platform/linux-process-table";
import { LocalDaemonLauncher } from "./launcher";
import type {
  CoordinatorServiceRegistrar,
  DaemonLauncher,
  DaemonServiceDefinition,
  DaemonStarted,
  DaemonWorkspaceConfig,
  LocalDaemonLauncherOptions,
} from "./launcher";

/**
 * The Coordinator on a Linux machine without systemd (task #538): the Computer's own process,
 * started detached by the installer and left running. Nothing starts it at boot and nothing
 * restarts it after a crash; the next attach or start starts it again. The installer's `Detached`
 * backend (`crates/installer/src/service/detached.rs`) owns the files in the state directory:
 * the spec it runs (`detached-service.json`), the pid file (`detached.pid`, `<pid> <started_at>`)
 * and the log. This host reads the pid file to know whether the process is that one and signals
 * it to stop, and asks the registrar (the installer's `start`) to start it.
 */
const DETACHED_SPEC_FILE = "detached-service.json";
const DETACHED_PID_FILE = "detached.pid";
/** systemd's default `PATH` for a user service. */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const STOP_WAIT_MS = 15_000;
const POLL_MS = 50;

/** systemd is present when its manager is running (`sd_booted`) and `systemctl` is on `PATH`;
 * either missing is the detached case. A present systemd without a user session bus is not. */
export function systemdPresent(
  deps: { runDirectory?: string; path?: string | undefined } = {},
): boolean {
  if (!existsSync(join(deps.runDirectory ?? "/run", "systemd", "system"))) return false;
  const path = "path" in deps ? deps.path : process.env.PATH;
  return path !== undefined && Bun.which("systemctl", { PATH: path }) !== null;
}

/** Field 22 of `/proc/<pid>/stat` (clock ticks since boot), or null when the process is gone. */
export async function processStartedAt(pid: number): Promise<number | null> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"))?.startTicks ?? null;
  } catch {
    return null;
  }
}

/** The pid the pid file names when it is still the process the installer started. */
export async function detachedPid(
  stateDirectory: string,
  startedAtOf: (pid: number) => Promise<number | null> = processStartedAt,
): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(join(stateDirectory, DETACHED_PID_FILE), "utf8");
  } catch {
    return null;
  }
  const [pid, startedAt] = text.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(pid) || !pid || !Number.isFinite(startedAt)) return null;
  return (await startedAtOf(pid)) === startedAt ? pid : null;
}

export class DetachedDaemonHost implements DaemonLauncher {
  readonly #stateDirectory: string;
  readonly #spec: { program: string; args: string[]; env: Record<string, string> };
  readonly #registrar: CoordinatorServiceRegistrar;
  readonly #startedAtOf: (pid: number) => Promise<number | null>;
  readonly #local: LocalDaemonLauncher;

  constructor(options: {
    homeDirectory: string;
    executablePath: string;
    socketPath: string;
    stateDirectory?: string;
    serverUrl?: string;
    daemonConnectionEndpoint?: string;
    runtimeHomeDirectory?: string;
    registrar: CoordinatorServiceRegistrar;
    /** Tests replace the `/proc` read. */
    processStartedAt?: (pid: number) => Promise<number | null>;
    connect?: LocalDaemonLauncherOptions["connect"];
  }) {
    this.#stateDirectory =
      options.stateDirectory ?? join(options.homeDirectory, ".coforge", "daemon");
    // The same command and environment as the systemd unit's ExecStart and Environment lines.
    this.#spec = {
      program: options.executablePath,
      args: ["__daemon", "--socket", options.socketPath, "--state-directory", this.#stateDirectory],
      // The installer starts the process from an empty environment, so what a systemd unit gets
      // by default (a home directory and a PATH) is written out here.
      env: {
        HOME: options.runtimeHomeDirectory ?? options.homeDirectory,
        PATH: DEFAULT_PATH,
        ...(options.daemonConnectionEndpoint
          ? { COFORGE_DAEMON_CONNECTION_ENDPOINT: options.daemonConnectionEndpoint }
          : {}),
      },
    };
    this.#registrar = options.registrar;
    this.#startedAtOf = options.processStartedAt ?? processStartedAt;
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: this.#stateDirectory,
      serverUrl: options.serverUrl,
      connect: options.connect,
    });
  }

  #pid() {
    return detachedPid(this.#stateDirectory, this.#startedAtOf);
  }

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  /** What the installer runs: the unit's command and its environment (a home directory, a PATH and the
   * connection endpoint: paths and addresses only). The Daemon reads its credentials from its own
   * storage when it runs; none is written here. */
  serviceDefinition(): DaemonServiceDefinition {
    return {
      manager: "detached",
      contents: JSON.stringify(this.#spec),
      path: join(this.#stateDirectory, DETACHED_SPEC_FILE),
    };
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<DaemonStarted> {
    await this.ensureRunning();
    return this.#local.ensureStarted(config);
  }

  async ensureRunning(): Promise<void> {
    // A Computer the person already runs (`foreground` under their own supervisor, or a start
    // from another shell) answers the handshake: use it, and never start a second one.
    if (!(await this.#pid()) && !(await this.#local.isRunning()))
      await this.#registrar.registerAndStart();
    await this.#local.ensureRunning();
  }

  command(
    operation: "start" | "stop" | "restart" | "detach",
    workspaceId?: string,
    detachTarget?: { computerId: string; serverHttpUrl: string },
  ): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.command(operation, workspaceId, detachTarget);
  }

  /** Asks the process to exit and, past the wait, ends it; the pid file goes with it. */
  async stop(): Promise<void> {
    const pid = await this.#pid();
    if (pid) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + STOP_WAIT_MS;
      while (Date.now() < deadline && (await this.#pid())) {
        await Bun.sleep(POLL_MS);
      }
      if (await this.#pid()) process.kill(pid, "SIGKILL");
    }
    await rm(join(this.#stateDirectory, DETACHED_PID_FILE), { force: true });
  }

  /** A detached process can always be restarted: there is no manager that could refuse. */
  async assertRestartable(): Promise<void> {}

  async restart(): Promise<void> {
    await this.stop();
    await this.ensureRunning();
  }
}
