import { homedir } from "node:os";

import {
  createDaemonHost,
  resolveComputerInstallDirectory,
  resolveDaemonExecutablePath,
  type DaemonServiceDefinition,
} from "@lrm/coforge-daemon";

import { e2eOverride, resolveDaemonConnectionEndpoint } from "#src/cloud-rpc-transport";
import {
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
  type PathEnvironment,
} from "#src/paths";
import { currentComputerPlatform, type SupportedPlatform } from "#src/platform";
import { COFORGE_SERVER_URL } from "#src/release-channel";

/** The user and process facts a daemon host reads from the machine it runs on. */
export type DaemonHostMachine = {
  homeDirectory: string;
  uid: number;
  environment: PathEnvironment;
  /** Windows only: the task's user id. Defaults to the signed-in user. */
  windowsUserId?: string;
};

/** The user and process facts of the machine this process runs on. */
export function currentMachine(): DaemonHostMachine {
  return { homeDirectory: homedir(), uid: process.getuid?.() ?? 0, environment: process.env };
}

/** The executable the Coordinator service runs: the installation's `active` link, wherever the
 * process asking lives. */
export function daemonExecutablePathFor(
  platform: SupportedPlatform,
  installDirectory: string,
  environment: PathEnvironment = process.env,
): string {
  // An E2E run points the service at a stand-in (`e2eOverride` applies the gate).
  return (
    e2eOverride(environment, "COFORGE_E2E_DAEMON_EXECUTABLE") ||
    resolveDaemonExecutablePath({ installRoot: installDirectory, platform })
  );
}

/** The platform host (launchd, systemd user, or Windows task) of the Coordinator service, built
 * from the install and state directories and the server this Computer talks to. */
export function createDaemonLauncher(
  platform: SupportedPlatform,
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
  machine: DaemonHostMachine = currentMachine(),
) {
  return createDaemonHost({
    platform,
    executablePath: daemonExecutablePathFor(platform, installDirectory, machine.environment),
    socketPath: resolveDaemonSocketPath({ platform, stateDirectory }),
    stateDirectory,
    serverUrl,
    daemonConnectionEndpoint: resolveDaemonConnectionEndpoint(serverUrl, machine.environment),
    homeDirectory: machine.homeDirectory,
    uid: machine.uid,
    userId: machine.windowsUserId,
  });
}

/** The service definition this Computer's own daemon host would write on `machine`: the same
 * directories, executable, socket and connection endpoint, rendered by the host itself. Reads
 * only; registers nothing. */
export function resolveServiceDefinition(
  machine: DaemonHostMachine & { platform: SupportedPlatform; serverUrl: string },
): DaemonServiceDefinition {
  const { platform } = machine;
  const stateDirectory = resolveComputerStateDirectory({
    platform,
    homeDirectory: machine.homeDirectory,
    environment: machine.environment,
  });
  const installDirectory = resolveComputerInstallDirectory({
    platform,
    homeDirectory: machine.homeDirectory,
  });
  return createDaemonLauncher(
    platform,
    installDirectory,
    stateDirectory,
    machine.serverUrl,
    machine,
  ).serviceDefinition();
}

/** The service definition for the machine this process runs on. */
export function currentServiceDefinition(): DaemonServiceDefinition {
  return resolveServiceDefinition({
    ...currentMachine(),
    platform: currentComputerPlatform().os,
    serverUrl: COFORGE_SERVER_URL,
  });
}
