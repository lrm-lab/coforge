export { LaunchdDaemonHost, launchdPlist } from "./launchd";
export { SystemdUserDaemonHost, systemdUserUnit } from "./systemd-user";
export { DetachedDaemonHost, detachedPid, systemdPresent } from "./detached";
export { WindowsUserDaemonHost, windowsDaemonTaskXml } from "./windows-task";
export { windowsTaskUserId } from "../platform/windows-scheduled-task";
export { LocalDaemonLauncher, resolveDaemonExecutablePath } from "./launcher";
export { COORDINATOR_SERVICE, coordinatorServiceName } from "./service-identity";

import type { CoordinatorServiceRegistrar } from "./launcher";
import { LaunchdDaemonHost } from "./launchd";
import { COORDINATOR_SERVICE } from "./service-identity";
import { DetachedDaemonHost, systemdPresent } from "./detached";
import { SystemdUserDaemonHost } from "./systemd-user";
import { WindowsUserDaemonHost } from "./windows-task";

export function createDaemonHost(input: {
  platform: NodeJS.Platform;
  executablePath: string;
  socketPath: string;
  stateDirectory?: string;
  serverUrl?: string;
  daemonConnectionEndpoint?: string;
  homeDirectory: string;
  uid: number;
  serviceName?: string;
  runtimeHomeDirectory?: string;
  /** Linux only: whether systemd is present; detected from the machine when absent. */
  hasSystemd?: boolean;
  /** Windows only: the task's user id. Defaults to the signed-in user. */
  userId?: string;
  /** Registers and starts the Coordinator service when the platform manager does not know it. */
  registrar: CoordinatorServiceRegistrar;
}) {
  if (input.platform === "darwin") {
    return new LaunchdDaemonHost({ ...input, label: COORDINATOR_SERVICE.launchdLabel });
  }
  if (input.platform === "linux") {
    // Without systemd the Computer runs its own detached process; with it, a missing user
    // session bus stays an error (task #538).
    return (input.hasSystemd ?? systemdPresent())
      ? new SystemdUserDaemonHost(input)
      : new DetachedDaemonHost(input);
  }
  if (input.platform === "win32") return new WindowsUserDaemonHost(input);
  throw new Error(`unsupported platform: ${input.platform}`);
}
