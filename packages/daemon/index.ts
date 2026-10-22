import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalInboxRequest, RunnerHoldReason } from "@lrm/coforge-sdk/internal";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { startAgentProxy, type AgentProxyRuntime } from "#src/agent-proxy";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import {
  DaemonRuntime,
  type BusyAgentReport,
  type DaemonConfig,
} from "#src/daemon-runtime/runtime";
import { upgradeOperationsInConfig } from "#src/daemon-runtime/upgrade-result-reporter";
import { defaultCodeAgentDiscovery } from "#src/daemon-runtime/code-agent-inventory-sync";
import { diagnosticErrorCode } from "#src/platform/diagnostic-error-code";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import {
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
} from "#src/connection/daemon-connection";
import { COFORGE_DAEMON_SERVER_URL, daemonConnectionEndpoint } from "#src/connection/built-server";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { configureDaemonLogging } from "#src/platform/daemon-logging";
import { installerJournalExists } from "#src/platform/installer-journal";
import { stopLaunchdAgents } from "#src/platform/launchd-process";
import { reapLeftoverAgentProcesses } from "#src/platform/linux-agent-processes";
import {
  WorkspaceHealthJournal,
  workspaceDegradedMessage,
  workspaceHealthJournalPath,
} from "#src/supervisor/workspace-health-journal";
import { WorkspaceParking } from "#src/supervisor/workspace-parking";
import { guardWorkspaceRunnerStart } from "#src/supervisor/workspace-runner-guard";
export { launchdJobs } from "#src/platform/launchd-job";
export { stopWorkspaceAgentProcesses } from "#src/platform/linux-agent-processes";
export { FileBindingStore } from "#src/supervisor/binding-store";
export { workspaceLaunchdIdentity } from "#src/supervisor/launchd-workspace-instance";
export { workspaceStateDirectory } from "#src/supervisor/workspace-instance";
export {
  WORKSPACE_HEALTH_CRASH_WINDOW_MS,
  WORKSPACE_HEALTH_DEGRADED_THRESHOLD,
  WorkspaceHealthJournal,
  workspaceDegradedMessage,
  workspaceHealthJournalPath,
  workspaceHealthRecoveryCommand,
  workspaceParkedDescription,
  workspaceParkedMessage,
  workspaceParkedRecovery,
} from "#src/supervisor/workspace-health-journal";
export type { WorkspaceHealthState } from "#src/supervisor/workspace-health-journal";
export { runMachineSupervisor } from "#src/supervisor/run-supervisor";
export type { LifecycleFailure } from "#src/supervisor/machine-supervisor";
export {
  workspaceSocketPath,
  type WorkspaceCloudConnectionReport,
} from "#src/supervisor/workspace-start-outcome";
export {
  holdRunnersUntilQuiescent,
  RUNNER_HOLD_MS,
  RUNNER_HOLD_POLL_MS,
} from "#src/supervisor/runner-hold";
export type {
  RunnerHoldOptions,
  RunnerHoldOutcome,
  RunnerHoldSnapshot,
} from "#src/supervisor/runner-hold";
export { runLaunchdAgent } from "#src/platform/launchd-process";

export type { AgentRuntimeConfig, AgentSession, AgentSessionOptions } from "@coforge/agent";
export type {
  AgentRuntimeEvent,
  CodeAgentProvider,
  CodeAgentProviderFactory,
} from "#src/code-agent/contract";
export { createCodeAgentProvider } from "#src/code-agent/registry";
export { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
export { CodexProvider } from "#src/code-agent/codex/provider";
export { readCodexUsage } from "#src/code-agent/codex/usage";
export { readClaudeCodeUsage } from "#src/code-agent/claude-code/usage";
export { CoforgeProvider, PiProvider } from "#src/code-agent/pi/provider";
export { KiroProvider } from "#src/code-agent/kiro/provider";
export { startDaemonLocalRpcServer } from "#src/local-rpc";
export { startAgentProxy } from "#src/agent-proxy";
export {
  COORDINATOR_SERVICE,
  coordinatorServiceName,
  createDaemonHost,
  LaunchdDaemonHost,
  launchdPlist,
  SystemdUserDaemonHost,
  systemdUserUnit,
  WindowsUserDaemonHost,
  windowsDaemonTaskXml,
  windowsTaskUserId,
} from "#src/daemon-host/index";
export {
  DaemonCommandRejectedError,
  LocalDaemonLauncher,
  resolveDaemonExecutablePath,
} from "#src/daemon-host/launcher";
export {
  cleanupComputerUpgradeJob,
  computerUpgradeJobLabel,
  computerUpgradeTaskName,
  computerUpgradeUnitName,
} from "#src/platform/computer-upgrade-launcher";
export { readComputerUpgradeReceipt } from "#src/platform/computer-upgrade-receipts";
export { resolveComputerInstallDirectory } from "#src/platform/computer-install-directory";
export {
  readUpgradeReceipt,
  upgradeReceiptPath,
  upgradeResultsDirectory,
  type UpgradeReceiptFile,
} from "#src/platform/upgrade-receipt-file";
export {
  acquireProcessLock,
  isLockContention,
  PROCESS_LOCK_CONTENTION_CODES,
  PROCESS_LOCK_STATEMENTS,
} from "#src/platform/process-lock";
export { readOperatingSystem } from "#src/platform/operating-system";
export { writeLoginShellPathProbe } from "#src/platform/login-shell-path";
export {
  readLoginShellPath,
  type LoginShellPathRecord,
} from "#src/platform/login-shell-path-state";
export type { ProcessLock } from "#src/platform/process-lock";
export type {
  DaemonLauncher,
  DaemonStarted,
  DaemonCommandRunner,
  DaemonWorkspaceConfig,
} from "#src/daemon-host/launcher";
export { DaemonConfigStore } from "#src/persistence/daemon-config";
export { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
export { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
export { AgentStateMachine } from "#src/agent-runtime/agent-state-machine";
export { createAgentActivity } from "#src/agent-runtime/agent-activity";
export type { AgentRuntime, AgentStatus } from "#src/agent-runtime/agent-process-manager";
export type { AgentActivity, AgentActivityLevel } from "#src/agent-runtime/agent-activity";
export type {
  AgentStateEvent,
  AgentStateTransition,
  AgentStatus as AgentStateStatus,
} from "#src/agent-runtime/agent-state-machine";
export {
  DaemonRuntime,
  type DaemonConfig,
  type WorkspaceConfig,
} from "#src/daemon-runtime/runtime";
export {
  SystemdWorkspaceInstance,
  workspaceUnit,
} from "#src/supervisor/systemd-workspace-instance";
export { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
export {
  AgentAppInbox,
  type AgentAppItem,
  type MintAppItem,
} from "#src/agent-app-inbox/agent-app-inbox";
export {
  InMemoryDaemonCredentialStore,
  FileDaemonCredentialStore,
  type DaemonCredentialStore,
} from "#src/credentials/credential-store";
export type { AgentMessageHttpClient } from "#src/connection/agent-http-clients";
export {
  DaemonConnection,
  defaultCentrifugeWorkspaceClientFactory,
  type DaemonConnectionClient,
  type DaemonConnectionConfig,
  type DaemonConnectionClientFactory,
} from "#src/connection/daemon-connection";
export { COFORGE_DAEMON_SERVER_URL, daemonConnectionEndpoint } from "#src/connection/built-server";

const DAEMON_CATEGORY = ["coforge", "daemon"];
/** `--socket` is required for every launch this build understands; a launch missing it is a
 * precondition no restart can fix. */
const MISSING_SOCKET_REASON = "Daemon requires --socket";

export async function runDaemon(args: string[], computerVersion?: string): Promise<void> {
  const argument = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const socketPath = argument("--socket");
  const stateDirectoryArg = argument("--state-directory");
  const daemonStateDirectory = stateDirectoryArg ?? join(homedir(), ".coforge", "daemon");
  await configureDaemonLogging(daemonStateDirectory);
  const healthJournal = new WorkspaceHealthJournal(
    workspaceHealthJournalPath(daemonStateDirectory),
  );
  if (!socketPath) {
    // Terminal, not a crash to retry: restarting this exact invocation can never supply the
    // missing argument. Latching degraded and exiting 0 (see the degraded branch below for why
    // exit 0 is what stops both supervisors' restart loop) keeps a broken launch from spinning
    // forever instead of surfacing once with the fix. Only latch when `--state-directory` was
    // itself explicit: under every OS-supervised launch (the only shipped path) the Coordinator
    // always supplies both flags together, so a launch missing `--socket` but not
    // `--state-directory` never happens there. Without an explicit `--state-directory` this
    // falls back to the shared default `~/.coforge/daemon` - not a real per-Workspace directory
    // the Coordinator's `clearHealth` seam ever reaches - so writing a latch there could
    // permanently poison a later, unrelated standalone run with no way to clear it short of
    // deleting the file by hand. A hand-run invocation missing both flags gets today's plain
    // failure instead, exactly as before this change.
    if (stateDirectoryArg) await healthJournal.markTerminal(MISSING_SOCKET_REASON);
    const brokenConfig = stateDirectoryArg
      ? await new DaemonConfigStore(daemonStateDirectory, {
          serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
        })
          .load()
          .catch(() => null)
      : null;
    getLogger(DAEMON_CATEGORY).error(
      workspaceDegradedMessage(MISSING_SOCKET_REASON, brokenConfig?.workspaceId),
      { event: "daemon:invalid_arguments" },
    );
    await dispose();
    process.exitCode = 0;
    return;
  }
  return withContext(
    {
      service: "coforge-daemon",
      version: COFORGE_DAEMON_VERSION,
      process_role: "daemon",
      pid: process.pid,
    },
    async () => {
      const logger = getLogger(DAEMON_CATEGORY);
      logger.info("Daemon process started", { event: "daemon:started", outcome: "ok" });
      if (process.platform === "darwin" && Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX) {
        const directory = Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY;
        if (!directory) throw new Error("Workspace Agent job directory is missing");
        await stopLaunchdAgents(Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX, directory);
      }
      const credentials = new FileDaemonCredentialStore();
      const configStore = new DaemonConfigStore(daemonStateDirectory, {
        serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
      });
      let config = await configStore.load();
      // Before any real work (Agent proxy, Workspace connection): let the health journal say
      // whether the previous run(s) died unexpectedly often enough to stop this restart loop.
      const guard = await guardWorkspaceRunnerStart(healthJournal);
      let runtime: DaemonRuntime | undefined;
      const parking = new WorkspaceParking(
        healthJournal,
        () => config?.workspaceId,
        () => runtime?.cloudConnectFailure(),
      );
      if (guard.action === "parked") {
        parking.logParked(guard.reason);
        await dispose();
        process.exitCode = 0;
        return;
      }
      if (guard.action === "exit") {
        logger.error(workspaceDegradedMessage(guard.reason, config?.workspaceId), {
          event: "daemon:workspace_degraded",
          reason: guard.reason,
          crash_count: guard.crashCount,
          degraded_since: guard.since,
        });
        await dispose();
        process.exitCode = 0;
        return;
      }
      if (process.platform === "linux" && config?.workspaceId)
        await reapLeftoverAgentProcesses(config.workspaceId, logger);
      const requireRuntime = (): DaemonRuntime => {
        if (!runtime) throw new Error("daemon runtime is not running");
        return runtime;
      };
      const agentRequests = () => requireRuntime().agentRequests;
      // Every caller awaits inside a try, so a missing runtime surfaces as a rejected call.
      const agentProxy = startAgentProxy({
        runtime: {
          agentMessage: async (...input) => requireRuntime().agentMessage(...input),
          agentAttachment: async (...input) => agentRequests().agentAttachment(...input),
          agentAttachmentUpload: async (...input) =>
            agentRequests().agentAttachmentUpload(...input),
          agentAttachmentUploadSessionCreate: async (...input) =>
            agentRequests().agentAttachmentUploadSessionCreate(...input),
          agentAttachmentUploadSessionComplete: async (...input) =>
            agentRequests().agentAttachmentUploadSessionComplete(...input),
          agentAttachmentUploadSessionCancel: async (...input) =>
            agentRequests().agentAttachmentUploadSessionCancel(...input),
          agentAttachmentUploadSessionGet: async (...input) =>
            agentRequests().agentAttachmentUploadSessionGet(...input),
          inbox: async (...input) => requireRuntime().inbox(...input),
          reminder: async (...input) => requireRuntime().reminder(...input),
          agentTask: async (...input) => requireRuntime().agentTask(...input),
          agentMemoryDisposition: async (...input) =>
            agentRequests().agentMemoryDisposition(...input),
          agentOpenviking: async (...input) => agentRequests().agentOpenviking(...input),
          memoryFence: (agentId) => requireRuntime().memoryFence(agentId),
          agentChannel: async (...input) => agentRequests().agentChannel(...input),
          agentActionPrepare: async (...input) => agentRequests().agentActionPrepare(...input),
          agentWeeklyReport: async (...input) => agentRequests().agentWeeklyReport(...input),
          agentWeeklyReportCollect: async (...input) =>
            agentRequests().agentWeeklyReportCollect(...input),
          agentWeeklyReportKeyPoints: async (...input) =>
            agentRequests().agentWeeklyReportKeyPoints(...input),
          agentWeeklyReportMemory: async (...input) =>
            agentRequests().agentWeeklyReportMemory(...input),
          workspaceInfo: async (...input) => agentRequests().workspaceInfo(...input),
          githubCredential: async (...input) => agentRequests().githubCredential(...input),
          githubCommitTrailers: async (...input) => agentRequests().githubCommitTrailers(...input),
          manualGet: async (...input) => agentRequests().manualGet(...input),
          manualSearch: async (...input) => agentRequests().manualSearch(...input),
          version: async (...input) => requireRuntime().version(...input),
          userInfo: async (...input) => agentRequests().userInfo(...input),
          profileShow: async (...input) => agentRequests().profileShow(...input),
          profileUpdate: async (...input) => agentRequests().profileUpdate(...input),
          appConfigGet: async (...input) => agentRequests().appConfigGet(...input),
          appConfigUpdate: async (...input) => agentRequests().appConfigUpdate(...input),
          agentApp: async (...input) => agentRequests().agentApp(...input),
          mentionPending: async (...input) => agentRequests().mentionPending(...input),
          mentionExecute: async (...input) => agentRequests().mentionExecute(...input),
          mentionDelivery: async (...input) => agentRequests().mentionDelivery(...input),
          issueAgentContext: (agentId) => requireRuntime().issueAgentContext(agentId),
          // Every proxy route must reach the runtime here: an unwired handler is a 404 for the
          // Agent's CLI, so a new `AgentProxyRuntime` member fails to compile until it is added.
        } satisfies Required<AgentProxyRuntime>,
      });
      process.env.COFORGE_AGENT_PROXY_URL = agentProxy.url;
      // `config` was already loaded above, ahead of the health-journal guard.
      const supervisorSocket = Bun.env.COFORGE_SUPERVISOR_SOCKET;
      const supervisorControl = (...request: Parameters<LocalDaemonLauncher["control"]>) =>
        new LocalDaemonLauncher({
          executablePath: process.execPath,
          socketPath: supervisorSocket!,
          spawn: () => {},
        }).control(...request);
      const createRuntime = (connection: DaemonConfig) =>
        new DaemonRuntime(
          connection,
          createCodeAgentProvider,
          credentials,
          {
            create: () =>
              new DaemonConnection(
                daemonConnectionEndpoint(COFORGE_DAEMON_SERVER_URL),
                defaultCentrifugeWorkspaceClientFactory,
              ),
          },
          agentProxy,
          defaultCodeAgentDiscovery(daemonStateDirectory),
          daemonStateDirectory,
          {
            recoveredRestartRequestIds:
              (config as { restartRequestIds?: string[] } | null)?.restartRequestIds ?? [],
            recoveredUpgradeRequestIds:
              (config as { upgradeRequestIds?: string[] } | null)?.upgradeRequestIds ?? [],
            recoveredUpgradeResults: upgradeOperationsInConfig(config).results,
            // The per-Workspace config file the Coordinator wrote before starting this process and
            // rewrites while it runs (an upgrade recorded, settled, or acknowledged).
            readUpgradeOperations: async () => upgradeOperationsInConfig(await configStore.load()),
            acknowledgeUpgradeResult: supervisorSocket
              ? async (requestId: string) => {
                  if (!config) throw new Error("Workspace is not configured");
                  await supervisorControl("upgrade_ack", config.workspaceId, requestId);
                }
              : undefined,
            requestRestart: supervisorSocket
              ? async (requestId: string) => {
                  if (!config) throw new Error("Workspace is not configured");
                  await supervisorControl("restart", config.workspaceId, requestId);
                }
              : undefined,
            connectionRefused: (reason) => void parking.park(reason),
            installerJournalExists: () => installerJournalExists(),
            requestUpgrade: async (requestId: string, expectedVersion?: string) => {
              if (!config) throw new Error("Workspace is not configured");
              if (!expectedVersion) throw new Error("upgrade expected version is unavailable");
              await supervisorControl("upgrade", config.workspaceId, requestId, expectedVersion);
            },
          },
          computerVersion,
        );
      const daemon = {
        async configure(connection: DaemonConfig) {
          const nextConfig = configStore.bindToServer(connection);
          // A configure request is the Workspace-page replacement operation. Stop
          // the old connection and all children before adopting the new identity.
          await runtime?.stop();
          config = nextConfig;
          const next = createRuntime(nextConfig);
          runtime = next;
          await parking.start(() => next.start(nextConfig));
        },
        async start() {
          if (!config) return parking.unconfigured();
          const current = config;
          const next = (runtime ??= createRuntime(current));
          await parking.start(() => next.start(current));
        },
        cloudConnection: () => parking.cloudConnection,
        async stopAll() {
          await runtime?.stop();
          runtime = undefined;
        },
        async restart() {
          await this.stopAll();
          await this.start();
        },
        inbox: async (context: string, request: LocalInboxRequest) =>
          requireRuntime().inbox(context, request),
        // Runner hold. A Workspace with no configured runtime has nothing to drain and
        // reports itself quiescent, so it never holds a restart up.
        async hold(reason: RunnerHoldReason) {
          return { held: true, busyAgents: stampWorkspace(runtime?.holdRunners(reason)) };
        },
        async release() {
          return { held: false, busyAgents: stampWorkspace(runtime?.releaseRunners()) };
        },
      };
      function stampWorkspace(agents: BusyAgentReport[] = []) {
        return agents.map((agent) => ({ ...agent, workspaceId: config?.workspaceId ?? "" }));
      }
      // The Coordinator polls this socket for readiness within a 30s budget after spawning the
      // Workspace, so it must open before anything that can block on the network (Code Agent
      // discovery, in particular). The handshake it answers only needs pid/version/serverUrl, so
      // starting it ahead of `daemon.start()` is safe for both the supervised and standalone paths.
      const localRpc = await startDaemonLocalRpcServer({
        socketPath,
        version: COFORGE_DAEMON_VERSION,
        validateCredential: (credential) => credential.length > 0,
        runtime: daemon,
        credentials,
        configStore,
      });
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // A SIGTERM/SIGINT shutdown is deliberate - an operator stop, a restart, or an upgrade
        // (`machine-supervisor.ts`'s `#stop`) - never an unexpected death; clearing the live
        // marker here is what keeps the next start from counting it as a crash.
        await healthJournal.recordGracefulStop();
        await daemon.stopAll();
        agentProxy.close();
        await localRpc.close();
        logger.info("Daemon process stopped", { event: "daemon:stopped", outcome: "ok" });
        await dispose();
        resolveShutdown();
      };
      let resolveShutdown!: () => void;
      const shutdownRequested = new Promise<void>((resolve) => {
        resolveShutdown = resolve;
      });
      process.once("SIGINT", () => void shutdown());
      process.once("SIGTERM", () => void shutdown());
      const parked = parking.bindShutdown(shutdown);
      try {
        await daemon.start();
      } catch (error) {
        // A refusal for good is parking the Workspace instead (`WorkspaceParking`). A shutdown
        // ends a start still waiting for the cloud on purpose.
        if (
          parking.cloudConnection.state === "not_connected" &&
          !(error instanceof DaemonConnectionStoppedError)
        )
          logger.error("Daemon failed to recover configured Workspace", {
            event: "daemon:workspace_recovery_failed",
            error_code: diagnosticErrorCode(error),
            outcome: "failed",
          });
      }
      await Promise.all([parked, shutdownRequested]);
    },
  );
}

// Standalone source/development harness; releases enter through Computer.
if (import.meta.main) await runDaemon(Bun.argv.slice(2));
