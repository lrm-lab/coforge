import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile } from "#src/platform/private-file";

import {
  validateWorkspaceEndpoint,
  WORKSPACE_RELAUNCH_SECONDS,
  type WorkspaceInstanceConfig,
  type WorkspaceLaunchAttribution,
} from "./workspace-instance";
export type { WorkspaceInstanceConfig } from "./workspace-instance";

export type SystemdUserCommand = (args: string[]) => Promise<number>;
export type SystemdUserCapture = (args: string[]) => Promise<{ code: number; stdout: string }>;

const serviceProperties = [
  "Restart=on-failure",
  `RestartSec=${WORKSPACE_RELAUNCH_SECONDS}s`,
  "KillMode=mixed",
  "OOMPolicy=continue",
  "SendSIGKILL=yes",
  "TimeoutStopSec=10s",
];

/** One user-manager unit is the process-containment seam for one Workspace. */
export class SystemdWorkspaceInstance {
  readonly unitName: string;
  readonly unitPath: string;

  constructor(
    private readonly config: WorkspaceInstanceConfig,
    private readonly run: SystemdUserCommand,
    private readonly write: (path: string, content: string) => Promise<void> = writePrivateFile,
    private readonly capture: SystemdUserCapture = async (args) => {
      const process = Bun.spawn(["systemctl", "--user", ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      return { code: await process.exited, stdout: await new Response(process.stdout).text() };
    },
    private readonly runTransient: SystemdUserCommand = (args) =>
      Bun.spawn(["systemd-run", "--user", "--no-ask-password", "--no-block", ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exited,
  ) {
    const identity = new Bun.CryptoHasher("sha256")
      .update(`${config.stateRoot}\0${config.workspaceId}`)
      .digest("hex")
      .slice(0, 24);
    this.unitName = `coforge-workspace-${identity}.service`;
    this.unitPath = join(config.unitDirectory, this.unitName);
  }

  async ensureStarted(
    beforeLaunch?: () => Promise<void>,
    attribution?: WorkspaceLaunchAttribution,
  ): Promise<number> {
    if (beforeLaunch && attribution && !(await this.#show()).exists) {
      const { command, environment } = workspaceService(this.config);
      const description = `CoForge Workspace ${this.config.workspaceId} (upgrade ${crypto.randomUUID()})`;
      const args = [
        `--unit=${this.unitName}`,
        `--description=${description}`,
        ...serviceProperties.map((property) => `--property=${property}`),
        ...environment.map((assignment) => `--setenv=${assignment}`),
        "--",
        ...command.map((part, index) => (index === 0 ? part : part.replaceAll("$", "$$"))),
      ];
      await beforeLaunch();
      let accepted = false;
      try {
        accepted = (await this.runTransient(args)) === 0;
      } catch {}
      if (accepted) {
        try {
          const observed = await this.#waitForMainPid();
          if (observed.description === description && observed.transient) {
            await attribution.observeLaunch(observed);
          } else await attribution.cancelAttribution();
          return observed.mainPid;
        } catch (error) {
          await attribution.cancelAttribution();
          throw error;
        }
      }
      await attribution.cancelAttribution();
    }
    await this.write(this.unitPath, workspaceUnit(this.config));
    await this.#runChecked(["daemon-reload"], "reload the systemd user manager");
    const state = await this.#show();
    if (state.active && state.mainPid > 0) return state.mainPid;
    await this.#runChecked(["start", this.unitName], `start ${this.unitName}`);
    return (await this.#waitForMainPid()).mainPid;
  }

  async stop(): Promise<void> {
    const state = await this.#show();
    if (state.exists) await this.#runChecked(["stop", this.unitName], `stop ${this.unitName}`);
    await rm(this.unitPath, { force: true });
    await this.#runChecked(["daemon-reload"], "reload the systemd user manager");
  }

  async identity(): Promise<{ mainPid: number; active: boolean; invocationId: string } | null> {
    const state = await this.#show();
    return state.exists
      ? { mainPid: state.mainPid, active: state.active, invocationId: state.invocationId }
      : null;
  }

  async #show(): Promise<{
    exists: boolean;
    active: boolean;
    mainPid: number;
    invocationId: string;
    description: string;
    transient: boolean;
  }> {
    const result = await this.capture([
      "show",
      this.unitName,
      "--property=ActiveState",
      "--property=MainPID",
      "--property=LoadState",
      "--property=InvocationID",
      "--property=Description",
      "--property=Transient",
    ]);
    const properties = new Map<string, string>();
    for (const line of result.stdout.trim().split("\n")) {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      if (separator < 1 || properties.has(key))
        throw new Error(`invalid systemd observation for ${this.unitName}`);
      properties.set(key, line.slice(separator + 1));
    }
    if (properties.get("LoadState") === "not-found")
      return {
        exists: false,
        active: false,
        mainPid: 0,
        invocationId: "",
        description: "",
        transient: false,
      };
    const pid = properties.get("MainPID") ?? "";
    const invocationId = properties.get("InvocationID") ?? "";
    if (
      result.code !== 0 ||
      !properties.get("LoadState") ||
      !properties.get("ActiveState") ||
      !/^\d+$/.test(pid) ||
      !Number.isSafeInteger(Number(pid)) ||
      ((Number(pid) > 0 || properties.get("ActiveState") === "active") &&
        !/^[0-9a-f]{32}$/.test(invocationId))
    )
      throw new Error(`could not query systemd state for ${this.unitName}`);
    return {
      exists: true,
      active: properties.get("ActiveState") === "active",
      mainPid: Number(pid),
      invocationId,
      description: properties.get("Description") ?? "",
      transient: properties.get("Transient") === "yes",
    };
  }

  async #waitForMainPid() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const state = await this.#show();
      if (state.active && state.mainPid > 0) return state;
      await Bun.sleep(50);
    }
    throw new Error(`Workspace unit ${this.unitName} did not become ready`);
  }

  async #runChecked(args: string[], action: string): Promise<void> {
    const code = await this.run(args);
    if (code !== 0) throw new Error(`could not ${action}`);
  }
}

function workspaceService(config: WorkspaceInstanceConfig) {
  validateWorkspaceEndpoint(config.daemonConnectionEndpoint);
  const environment = [`COFORGE_DAEMON_HOME=${config.stateDirectory}`];
  if (config.supervisorSocketPath) {
    environment.push(
      `COFORGE_SUPERVISOR_SOCKET=${config.supervisorSocketPath}`,
      `COFORGE_SUPERVISOR_STATE_PATH=${join(dirname(config.supervisorSocketPath), "upgrade-request-ids.json")}`,
    );
  }
  if (config.daemonConnectionEndpoint)
    environment.push(`COFORGE_DAEMON_CONNECTION_ENDPOINT=${config.daemonConnectionEndpoint}`);
  const command = [
    config.executablePath,
    "__workspace-daemon",
    "--socket",
    config.socketPath,
    "--state-directory",
    config.stateDirectory,
  ];
  for (const value of [config.workspaceId, ...command, ...environment]) {
    if (value.includes("\n") || value.includes("\r") || value.includes("\0"))
      throw new Error("invalid systemd unit value");
  }
  return { environment, command };
}

export function workspaceUnit(config: WorkspaceInstanceConfig): string {
  const { command, environment } = workspaceService(config);
  return `[Unit]
Description=CoForge Workspace ${escapeUnit(config.workspaceId)}

[Service]
${environment.map((assignment) => `Environment="${escapeUnit(assignment)}"`).join("\n")}
ExecStart=${command.map(escapeUnit).join(" ")}
${serviceProperties.join("\n")}

[Install]
`;
}

function escapeUnit(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll(" ", "\\x20");
}
