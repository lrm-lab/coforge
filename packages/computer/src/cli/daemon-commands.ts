// The daemon lifecycle and log-follow command wiring behind `start`, `stop`, `restart`, `logs`.

import {
  listMachineRunningProcJobs,
  removeWorkspaceProcJobLedger,
  stopMachineRunningProcJobs,
  workspaceStateDirectory,
  type DaemonCommandRunner,
} from "@lrm/coforge-daemon";
import { FileComputerConfig, loadBuildProfile } from "#src/local-config";
import { createDaemonLauncher } from "#src/daemon-service/daemon-host";
import {
  createRestartSupervisorHost,
  reportSkippedRestarts,
  restartSupervisor,
} from "./restart-supervisor";
import { stopComputer } from "./stop-computer";
import { createCommand as createClientCommand } from "#src/daemon-client/index";
import {
  DEFAULT_LOG_LINES,
  followComputerLogs,
  readComputerLogs,
  resolveLogSourceTarget,
} from "#src/logging/computer-logs";
import type { DaemonCommand, LogsCommand } from "#src/cli";
import { detectLogindSessionRisk } from "#src/logind-session-risk";

export function createCommand(
  platform: "darwin" | "linux" | "win32",
  installDirectory: string,
  stateDirectory: string,
  serverUrl: string,
  config: FileComputerConfig,
  logger?: import("@logtape/logtape").Logger,
  io: { stdout: (line: string) => void } = { stdout: (line) => console.log(line) },
  seams?: {
    launcher?: DaemonCommandRunner & {
      preflight?: () => Promise<void>;
      assertRestartable: () => Promise<void>;
      stop: () => Promise<void>;
    };
    resolveWorkspace?: (selector: string) => Promise<{ id: string; slug: string }>;
    callerIsAgentHosted?: boolean;
  },
): DaemonCommand {
  const launcher =
    seams?.launcher ?? createDaemonLauncher(platform, installDirectory, stateDirectory, serverUrl);
  const resolveWorkspace =
    seams?.resolveWorkspace ??
    (async (selector: string) => {
      const binding = await config.loadRegistration(selector);
      if (!binding) throw new Error(`Workspace '${selector}' is not registered locally`);
      return { id: binding.id, slug: binding.slug };
    });
  let suppressClientWrite = false;
  const command = createClientCommand({
    daemon: launcher,
    config,
    logger,
    hostingWorkspaceId: seams?.callerIsAgentHosted
      ? Bun.env.COFORGE_CURRENT_WORKSPACE_ID?.trim()
      : undefined,
    resolveWorkspace,
    write: (line) => {
      if (!suppressClientWrite) io.stdout(line);
    },
    logindRisk: () => detectLogindSessionRisk({ platform }),
  });
  return {
    async start(workspace) {
      await launcher.preflight?.();
      await loadBuildProfile(config, serverUrl, "daemon");
      await command.start(workspace);
    },
    async stop(workspace, options) {
      // A scoped stop is one Workspace runtime and goes through the Coordinator; an unscoped one
      // is the whole Computer, which only the manager that runs it can stop (task #696).
      if (workspace) {
        const resolved = options?.jobs
          ? await resolveWorkspace(workspace)
          : await resolveWorkspace(workspace).catch(() => undefined);
        suppressClientWrite = Boolean(options?.json);
        try {
          await command.stop(workspace);
        } finally {
          suppressClientWrite = false;
        }
        const stoppedJobs = options?.jobs
          ? await stopMachineRunningProcJobs(stateDirectory, {
              platform,
              workspaceId: resolved!.id,
            })
          : undefined;
        if (options?.json) {
          io.stdout(
            JSON.stringify({
              ok: true,
              workspace: resolved?.slug ?? workspace,
              stopped: true,
              ...(stoppedJobs
                ? {
                    stoppedProcJobs: stoppedJobs.stopped.length,
                    failedProcJobs: stoppedJobs.failed.length,
                  }
                : {}),
            }),
          );
        } else if (stoppedJobs) {
          io.stdout(
            `Stopped ${stoppedJobs.stopped.length} Agent background job(s) in workspace '${resolved!.slug}'.`,
          );
        }
        return;
      }
      logger?.info("Computer stop requested", { event: "computer:stopping" });
      await stopComputer(
        {
          assertRestartable: () => launcher.assertRestartable(),
          isRunning: () => launcher.isRunning(),
          stop: () => launcher.stop(),
          stopRuntimes: () => launcher.command("stop"),
          listRunningProcJobs: () => listMachineRunningProcJobs(stateDirectory, { platform }),
          stopProcJobs: () => stopMachineRunningProcJobs(stateDirectory, { platform }),
        },
        io,
        { json: options?.json ?? false, jobs: options?.jobs ?? false },
      );
      logger?.info("Computer stop completed", { event: "computer:stopped" });
    },
    async detach(workspace) {
      const resolved = workspace
        ? await resolveWorkspace(workspace).catch(() => undefined)
        : await config.loadRegistration().catch(() => undefined);
      const outcome = await command.detach(workspace);
      if ((outcome.kind === "detached" || outcome.kind === "key_revoked") && resolved?.id) {
        await stopMachineRunningProcJobs(stateDirectory, {
          platform,
          workspaceId: resolved.id,
        }).catch(() => {});
        await removeWorkspaceProcJobLedger(workspaceStateDirectory(stateDirectory, resolved.id));
      }
      return outcome;
    },
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
      return restartSupervisor(host, local, io, {
        callerIsAgentHosted: seams?.callerIsAgentHosted,
      });
    },
  };
}

export function createLogsCommand(
  dataDirectory: string,
  io: { stdout: (line: string) => void },
  options?: {
    stateDirectory?: string;
    resolveWorkspace?: (selector: string) => Promise<{ id: string; slug: string }>;
  },
): LogsCommand {
  return {
    async run(runOptions) {
      const target = await resolveLogSourceTarget({
        source: runOptions?.source ?? "computer",
        dataDirectory,
        stateDirectory: options?.stateDirectory,
        resolveWorkspace: options?.resolveWorkspace,
      });
      await readComputerLogs({
        logPath: target.logPath,
        missingMessage: target.missingMessage,
        lines: runOptions?.lines ?? DEFAULT_LOG_LINES,
        follow: runOptions?.follow ?? false,
        write: io.stdout,
      });
    },
    follow: () => followComputerLogs({ dataDirectory, write: io.stdout }),
  };
}
