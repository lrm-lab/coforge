// The daemon lifecycle and log-follow command wiring behind `start`, `stop`, `restart`, `logs`.

import { homedir } from "os";
import { FileComputerConfig, loadBuildProfile } from "#src/local-config";
import { resolveComputerConfigDirectory } from "#src/paths";
import { createDaemonLauncher } from "#src/daemon-service/daemon-host";
import {
  createRestartSupervisorHost,
  reportSkippedRestarts,
  restartSupervisor,
} from "./restart-supervisor";
import { createCommand as createClientCommand } from "#src/daemon-client/index";
import { followComputerLogs } from "#src/logging/computer-logs";
import type { DaemonCommand, LogsCommand } from "#src/cli";

export function createCommand(
  platform: "darwin" | "linux" | "win32",
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
  config: FileComputerConfig,
  logger?: import("@logtape/logtape").Logger,
  io: { stdout: (line: string) => void } = { stdout: (line) => console.log(line) },
): DaemonCommand {
  const launcher = createDaemonLauncher(platform, installDirectory, stateDirectory, serverUrl);
  const command = createClientCommand({
    daemon: launcher,
    logger,
    resolveWorkspace: async (selector) => {
      const config = new FileComputerConfig(
        resolveComputerConfigDirectory({
          platform,
          homeDirectory: homedir(),
          environment: Bun.env,
        }),
      );
      const binding = await config.loadRegistration(selector);
      if (!binding) throw new Error(`Workspace '${selector}' is not registered locally`);
      return { id: binding.id, slug: binding.slug };
    },
    write: io.stdout,
  });
  return {
    async start(workspace) {
      await launcher.preflight?.();
      await loadBuildProfile(config, serverUrl, "daemon");
      await command.start(workspace);
    },
    stop: (workspace) => command.stop(workspace),
    async restart(workspace) {
      await launcher.preflight?.();
      await loadBuildProfile(config, serverUrl, "daemon");
      const runtimes = await command.restart(workspace);
      // The supervisor skips disabled bindings on an unscoped restart; a scoped restart always
      // acts on its one target, so there is nothing to report there.
      if (!workspace) reportSkippedRestarts(io, runtimes);
    },
    restartSupervisor: () => {
      const { host, local } = createRestartSupervisorHost(
        platform,
        installDirectory,
        stateDirectory,
        serverUrl,
      );
      return restartSupervisor(host, local, io);
    },
  };
}

export function createLogsCommand(
  dataDirectory: string,
  io: { stdout: (line: string) => void },
): LogsCommand {
  return {
    follow: () => followComputerLogs({ dataDirectory, write: io.stdout }),
  };
}
