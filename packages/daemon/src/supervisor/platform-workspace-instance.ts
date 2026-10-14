import { join } from "node:path";
import { LaunchdWorkspaceInstance } from "./launchd-workspace-instance";
import { SystemdWorkspaceInstance } from "./systemd-workspace-instance";
import { WindowsWorkspaceInstance } from "./windows-workspace-instance";
import {
  workspaceStateDirectory,
  type WorkspaceInstance,
  type WorkspaceInstanceConfig,
} from "./workspace-instance";
import { workspaceSocketPath } from "./workspace-start-outcome";

/** What the Coordinator's host contributes to every Workspace instance it contains. */
export type WorkspaceInstanceHost = {
  platform: NodeJS.Platform;
  homeDirectory: string;
  executablePath: string;
  daemonConnectionEndpoint: string | undefined;
};

/** One Workspace's instance config under the Coordinator state root `stateRoot`. */
export function workspaceInstanceConfig(
  stateRoot: string,
  supervisorSocketPath: string,
  workspaceId: string,
  host: WorkspaceInstanceHost,
): WorkspaceInstanceConfig {
  return {
    stateRoot,
    workspaceId,
    executablePath: host.executablePath,
    socketPath: workspaceSocketPath(stateRoot, workspaceId),
    stateDirectory: workspaceStateDirectory(stateRoot, workspaceId),
    unitDirectory:
      host.platform === "darwin"
        ? join(stateRoot, "launchd-workspaces")
        : host.platform === "win32"
          ? join(stateRoot, "windows-workspaces")
          : join(host.homeDirectory, ".config", "systemd", "user"),
    supervisorSocketPath,
    daemonConnectionEndpoint: host.daemonConnectionEndpoint,
  };
}

/** Contains a Workspace with `platform`'s service manager: launchd, a Windows child, or systemd. */
export function platformWorkspaceInstance(
  config: WorkspaceInstanceConfig,
  platform: NodeJS.Platform,
): WorkspaceInstance {
  if (platform === "darwin") return new LaunchdWorkspaceInstance(config);
  if (platform === "win32") return new WindowsWorkspaceInstance(config);
  if (platform !== "linux")
    throw new Error("per-Workspace OS containment is not implemented on this platform");
  return new SystemdWorkspaceInstance(config, async (args) => {
    const command = Bun.spawn(["systemctl", "--user", ...args], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return await command.exited;
  });
}
