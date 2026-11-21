import { homedir } from "node:os";
import {
  COFORGE_DAEMON_SERVER_URL,
  FileBindingStore,
  resolveComputerInstallDirectory,
  runMachineSupervisor,
} from "@lrm/coforge-daemon";
import { createCommand, createLogsCommand } from "#src/cli/daemon-commands";
import { recordExternalSupervisor } from "#src/cli/foreground-supervisor";
import { createLoginCommand, createSetupCommand } from "#src/cli/login-setup-commands";
import { createLogoutCommand } from "#src/cli/logout-command";
import { createReleaseChannelCommand } from "#src/cli/release-channel-command";
import { createUpdateCommand } from "#src/cli/update-command";
import { createComputerUpgradeAdmission } from "#src/daemon-client/index";
import { createDaemonLauncher } from "#src/daemon-service/daemon-host";
import { runDoctorCleanup } from "#src/doctor/doctor-cleanup";
import { createDoctorCommand } from "#src/doctor/doctor-command";
import { prepareContainerBinding } from "#src/host/container-binding";
import { runHostProcess } from "#src/host/run-host";
import { configureComputerLogger } from "#src/logging/computer-logger";
import { createRunnerCommand } from "#src/runners/runner-command";
import { createStatusPorts } from "#src/status/create-status-ports";
import { createStatusCommand } from "#src/status/status-command";
import { runCli } from "./cli";
import { FileComputerConfig } from "./local-config";
import {
  resolveComputerConfigDirectory,
  resolveComputerStateDirectory,
  resolveDaemonSocketPath,
} from "./paths";
import { currentComputerPlatform } from "./platform";
import { COFORGE_RELEASE_FEED_URL, COFORGE_SERVER_URL } from "./release-channel";
import { COFORGE_COMPUTER_VERSION as VERSION } from "./version";

export async function runComputer(options: { callerIsAgentHosted?: boolean } = {}): Promise<void> {
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
  const resolveWorkspace = async (selector: string) => {
    const binding = await config.loadRegistration(selector);
    if (binding) return { id: binding.id, slug: binding.slug };
    const stored = await new FileBindingStore(stateDirectory, COFORGE_SERVER_URL)
      .load()
      .catch(() => []);
    const matched = stored.find((entry) => entry.workspaceId === selector);
    if (matched) return { id: matched.workspaceId, slug: matched.workspaceId };
    throw new Error(`Workspace '${selector}' is not registered locally`);
  };
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
        channel: createReleaseChannelCommand(stateDirectory, io),
        setup: createSetupCommand(io, config),
        updater: createUpdateCommand(io, {
          admitComputerUpgrade: createComputerUpgradeAdmission(
            createDaemonLauncher(platform.os, installDirectory, stateDirectory, COFORGE_SERVER_URL),
          ),
        }),
        daemon: createCommand(
          platform.os,
          installDirectory,
          stateDirectory,
          COFORGE_SERVER_URL,
          config,
          logging.logger,
          io,
          { callerIsAgentHosted: options.callerIsAgentHosted },
        ),
        logs: createLogsCommand(computerDirectory, io, {
          stateDirectory,
          resolveWorkspace,
        }),
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
          {
            runCleanup: (status) =>
              runDoctorCleanup({
                stateDirectory,
                coordinatorRunning:
                  status.supervisor.loaded ||
                  status.supervisor.rpc.reachable ||
                  Boolean(status.supervisor.detached),
                machineMutationLock: status.locks.machineMutationLock,
              }),
          },
        ),
        foreground: {
          run: async () => {
            await prepareContainerBinding(process.env, stateDirectory, COFORGE_DAEMON_SERVER_URL, {
              seedOnly: true,
            });
            await recordExternalSupervisor(stateDirectory, io.stderr);
            await runMachineSupervisor([
              "--socket",
              resolveDaemonSocketPath({ platform: platform.os, stateDirectory }),
              "--state-directory",
              stateDirectory,
            ]);
          },
        },
        host: { run: runHostProcess },
        runners: createRunnerCommand({
          daemon: createDaemonLauncher(
            platform.os,
            installDirectory,
            stateDirectory,
            COFORGE_SERVER_URL,
          ),
          resolveWorkspace: async (selector) => {
            const binding = await config.loadRegistration(selector);
            if (!binding) throw new Error(`Workspace '${selector}' is not registered locally`);
            return { id: binding.id, slug: binding.slug };
          },
          write: io.stdout,
        }),
      },
      io,
    );
  } finally {
    await logging.close();
  }
}
