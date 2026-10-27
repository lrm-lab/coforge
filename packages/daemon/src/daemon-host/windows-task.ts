import { LocalDaemonLauncher, type LocalDaemonLauncherOptions } from "./launcher";
import type {
  CoordinatorServiceRegistrar,
  DaemonLauncher,
  DaemonServiceDefinition,
  DaemonStarted,
  DaemonWorkspaceConfig,
} from "./launcher";
import { COORDINATOR_SERVICE } from "./service-identity";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { escapeXmlText } from "@lrm/coforge-sdk/internal";
import { runSchtasks, windowsTaskUserId } from "#src/platform/windows-scheduled-task";

type CommandRunner = (command: string[]) => Promise<number>;

const FOREGROUND_ADVICE =
  "Run `coforge-computer foreground` under an external supervisor; CoForge will not detach a fallback process.";

export type WindowsDaemonTaskXmlInput = {
  userId: string;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  daemonConnectionEndpoint?: string;
};

/**
 * Task Scheduler 1.2 XML for the machine-level Coordinator. Uses an interactive,
 * least-privilege LogonTrigger so `schtasks /Create /XML` succeeds without elevation —
 * the `/SC ONLOGON` CLI form is refused for non-admin users on current Windows builds.
 * RestartOnFailure approximates systemd `Restart=on-failure` / launchd KeepAlive for the
 * Coordinator process itself (Workspace children still use Coordinator reconcile).
 */
export function windowsDaemonTaskXml(input: WindowsDaemonTaskXmlInput): string {
  const daemonArgs = [
    "__daemon",
    "--socket",
    input.socketPath,
    ...(input.stateDirectory ? ["--state-directory", input.stateDirectory] : []),
  ].join(" ");
  const exec = input.daemonConnectionEndpoint
    ? {
        command: "cmd.exe",
        arguments: `/d /s /c "set COFORGE_DAEMON_CONNECTION_ENDPOINT=${input.daemonConnectionEndpoint}&& ${quoteCmdPath(input.executablePath)} ${daemonArgs}"`,
      }
    : { command: input.executablePath, arguments: daemonArgs };
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXmlText(input.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXmlText(input.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(exec.command)}</Command>
      <Arguments>${escapeXmlText(exec.arguments)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export class WindowsUserDaemonHost implements DaemonLauncher {
  readonly #taskName: string;
  readonly #run: CommandRunner;
  readonly #registrar: CoordinatorServiceRegistrar;
  readonly #local: LocalDaemonLauncher;
  readonly #xml: string;

  constructor(options: {
    taskName?: string;
    executablePath: string;
    socketPath: string;
    stateDirectory?: string;
    serverUrl?: string;
    daemonConnectionEndpoint?: string;
    userId?: string;
    /** Registers and starts the task when Task Scheduler does not know it. */
    registrar: CoordinatorServiceRegistrar;
    run?: CommandRunner;
    connect?: LocalDaemonLauncherOptions["connect"];
    timeoutMilliseconds?: number;
  }) {
    this.#taskName = options.taskName ?? COORDINATOR_SERVICE.windowsTask;
    this.#run = options.run ?? runSchtasks;
    this.#registrar = options.registrar;
    this.#xml = windowsDaemonTaskXml({
      userId: options.userId ?? windowsTaskUserId(),
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory,
      daemonConnectionEndpoint: options.daemonConnectionEndpoint,
    });
    this.#local = new LocalDaemonLauncher({
      executablePath: options.executablePath,
      socketPath: options.socketPath,
      stateDirectory: options.stateDirectory ?? join(homedir(), ".coforge", "daemon"),
      serverUrl: options.serverUrl,
      connect: options.connect,
      timeoutMilliseconds: options.timeoutMilliseconds,
    });
  }

  preflight(): Promise<void> {
    return this.#local.preflight();
  }

  /** The task XML the installer registers for this host, as text; `schtasks /XML` needs it written
   * as UTF-16 with a byte-order mark. */
  serviceDefinition(): DaemonServiceDefinition {
    return { manager: "windows-task", contents: this.#xml };
  }

  async ensureStarted(config: DaemonWorkspaceConfig): Promise<DaemonStarted> {
    // Prefer the user logon task. When it cannot be registered or run, fall back to an
    // already-running foreground supervisor - never detach an unmanaged process.
    try {
      await this.#startOrExplain();
    } catch (startFailure) {
      return this.#local.ensureStarted(config).catch(() => {
        throw startFailure;
      });
    }
    return this.#local.ensureStarted(config);
  }

  async ensureRunning(): Promise<void> {
    await this.#startOrExplain();
    await this.#local.ensureRunning();
  }

  command(
    operation: "start" | "stop" | "restart",
    workspaceId?: string,
  ): Promise<ManagedRuntimeIdentity[]> {
    return this.#local.command(operation, workspaceId);
  }

  async stop(): Promise<void> {
    const result = await this.#run(["schtasks.exe", "/End", "/TN", this.#taskName]);
    if (result !== 0) throw new Error("could not stop the CoForge Daemon user task");
  }

  /** Throws unless Task Scheduler knows the task, as a foreground, externally supervised Computer
   * never registered one. `restart()` would otherwise ask the registrar for a second Coordinator
   * beside the supervised one. */
  async assertRestartable(): Promise<void> {
    if ((await this.#run(["schtasks.exe", "/Query", "/TN", this.#taskName])) !== 0)
      throw new Error(`Task Scheduler has no "${this.#taskName}" task.`);
  }

  /** The in-place replacement `coforge-computer restart --supervisor` uses to restart the
   * Coordinator process itself. `/End`'s exit code is ignored - the task may already be
   * stopped, which is not a restart failure - and `/Run` (or the registrar, for a task Task
   * Scheduler does not know) is the actual restart. */
  async restart(): Promise<void> {
    await this.#run(["schtasks.exe", "/End", "/TN", this.#taskName]);
    await this.#startOrExplain();
    await this.#local.ensureRunning();
  }

  /** `#startTask`, with its failure explained: the error names the foreground supervisor as the
   * way to run without the task and carries the underlying failure as its `cause`. */
  async #startOrExplain(): Promise<void> {
    try {
      await this.#startTask();
    } catch (startFailure) {
      throw new Error(
        `The Windows user task could not start CoForge Daemon. ${FOREGROUND_ADVICE}`,
        { cause: startFailure },
      );
    }
  }

  /** Runs the registered task, or asks the registrar to register and start one Task Scheduler
   * does not know. */
  async #startTask(): Promise<void> {
    if ((await this.#run(["schtasks.exe", "/Query", "/TN", this.#taskName])) !== 0) {
      await this.#registrar.registerAndStart();
      return;
    }
    if ((await this.#run(["schtasks.exe", "/Run", "/TN", this.#taskName])) !== 0)
      throw new Error("schtasks /Run did not start the CoForge Daemon user task");
  }
}

function quoteCmdPath(path: string): string {
  return `"${path.replaceAll('"', '""')}"`;
}
