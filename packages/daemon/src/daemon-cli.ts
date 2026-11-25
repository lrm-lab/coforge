import { daemonStartupOptions } from "#src/daemon-startup-options";
import { type LocalInboxRequest, diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { startDaemonLocalRpcServer } from "#src/local-rpc";
import { startAgentProxy } from "#src/agent-proxy";
import { daemonAgentProxyRuntime } from "#src/agent-proxy-daemon-runtime";
import { createCodeAgentProvider } from "#src/code-agent/registry";
import { DaemonRuntime, type DaemonConfig } from "#src/daemon-runtime/runtime";
import { upgradeOperationsInConfig } from "#src/daemon-runtime/upgrade-result-reporter";
import { agentApiKeyRegistry } from "#src/agent-api-key-registry";
import { defaultCodeAgentDiscovery } from "#src/daemon-runtime/code-agent-inventory-sync";
import { captureLoginShellEnvironment } from "#src/daemon-runtime/login-shell-env";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import { DaemonConnection } from "#src/connection/daemon-connection";
import { COFORGE_DAEMON_SERVER_URL, daemonConnectionEndpoint } from "#src/connection/built-server";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { configureDaemonLogging } from "#src/platform/daemon-logging";
import { installerRecoveryRequired } from "#src/platform/installer-recovery-observation";
import { installerJournalExists } from "#src/platform/installer-journal";
import { stopLaunchdAgents } from "#src/platform/launchd-process";
import { captureStopSignal } from "#src/platform/stop-signal";
import { startupTiming } from "#src/platform/startup-timing";
import { refuseMissingSocket } from "#src/daemon-host/missing-socket";
import { reapLeftoverAgentProcesses } from "#src/platform/linux-agent-processes";
import {
  WorkspaceHealthJournal,
  workspaceDegradedMessage,
  workspaceHealthJournalPath,
} from "#src/supervisor/workspace-health-journal";
import { WorkspaceParking } from "#src/supervisor/workspace-parking";
import { guardWorkspaceRunnerStart } from "#src/supervisor/workspace-runner-guard";
import { writeWorkspaceInstanceRecord } from "#src/supervisor/process-workspace-instance";
import { holdWorkspaceDaemonLock } from "#src/supervisor/workspace-daemon-lock";
import {
  acquireComputerKeyClaim,
  computerKeyFingerprint,
  DuplicateComputerKeyError,
  type ComputerKeyClaim,
} from "#src/supervisor/computer-key-claim";
import { requestWorkspaceUpgrade } from "#src/supervisor/request-workspace-upgrade";
import { operatorRunnerPorts } from "#src/daemon-runtime/operator-runner-identities";

const DAEMON_CATEGORY = ["coforge", "daemon"];

export async function runDaemon(
  args: string[],
  computerVersion?: string,
  releaseChannel?: string,
  procMemoryConfigPath?: string,
): Promise<void> {
  const stopRequested = captureStopSignal();
  const { socketPath, stateDirectoryArg, daemonStateDirectory } = daemonStartupOptions(args);
  await configureDaemonLogging(daemonStateDirectory);
  const healthJournal = new WorkspaceHealthJournal(
    workspaceHealthJournalPath(daemonStateDirectory),
  );
  if (!socketPath)
    return refuseMissingSocket(daemonStateDirectory, !!stateDirectoryArg, healthJournal);
  return withContext(
    {
      service: "coforge-daemon",
      version: COFORGE_DAEMON_VERSION,
      process_role: "daemon",
      pid: process.pid,
    },
    async () => {
      const logger = getLogger(DAEMON_CATEGORY);
      logger.info("Daemon process started", {
        event: "daemon:started",
        outcome: "ok",
        ...startupTiming(),
      });
      if (process.platform === "darwin" && Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX) {
        const directory = Bun.env.COFORGE_WORKSPACE_JOB_DIRECTORY;
        if (!directory) throw new Error("Workspace Agent job directory is missing");
        await stopLaunchdAgents(Bun.env.COFORGE_WORKSPACE_AGENT_PREFIX, directory);
      }
      const loginShellEnv = captureLoginShellEnvironment();
      const credentials = new FileDaemonCredentialStore();
      const configStore = new DaemonConfigStore(daemonStateDirectory, {
        serverHttpUrl: COFORGE_DAEMON_SERVER_URL,
      });
      let config = await configStore.load();
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
      const bindingStop = new AbortController();
      void stopRequested.then(() => bindingStop.abort());
      let bindingLock: { release(): void } | undefined;
      let keyClaim: ComputerKeyClaim | null = null;
      const releaseLocks = () => {
        keyClaim?.release();
        keyClaim = null;
        bindingLock?.release();
        bindingLock = undefined;
      };
      const ensureBindingLock = async () => {
        if (bindingLock) return;
        bindingLock = await holdWorkspaceDaemonLock(daemonStateDirectory, {
          signal: bindingStop.signal,
          waiting: () =>
            logger.info("Another daemon already owns this Workspace binding; waiting for it", {
              event: "daemon:binding_lock_wait",
              outcome: "waiting",
            }),
        });
      };
      const acquireClaimFor = async (target: DaemonConfig): Promise<ComputerKeyClaim | null> => {
        const apiKey = await credentials.load(target.workspaceId, target.computerId);
        if (!apiKey) return null;
        if (keyClaim && keyClaim.fingerprint === computerKeyFingerprint(apiKey)) return keyClaim;
        return acquireComputerKeyClaim({
          apiKey,
          stateDirectory: daemonStateDirectory,
          workspaceId: target.workspaceId,
          computerId: target.computerId,
          version: COFORGE_DAEMON_VERSION,
          signal: bindingStop.signal,
        });
      };
      if (config?.workspaceId) {
        try {
          await ensureBindingLock();
          keyClaim = await acquireClaimFor(config);
        } catch (error) {
          if (error instanceof DuplicateComputerKeyError) {
            logger.error(error.message, {
              event: "daemon:duplicate_computer_key",
              key_fingerprint: error.fingerprint,
              holder_pid: error.holder?.pid,
              holder_state_directory: error.holder?.stateDirectory,
              outcome: "refused",
            });
            process.stderr.write(`${error.message}\n`);
            if (stateDirectoryArg) await healthJournal.markTerminal(error.message);
            await healthJournal.recordGracefulStop();
            releaseLocks();
            await dispose();
            process.exitCode = 0;
            return;
          }
          releaseLocks();
          if (!bindingStop.signal.aborted) {
            await dispose();
            throw error;
          }
          await dispose();
          process.exitCode = 0;
          return;
        }
        const instanceRecordPath = Bun.env.COFORGE_WORKSPACE_INSTANCE_RECORD;
        const instanceInvocationId = Bun.env.COFORGE_WORKSPACE_INVOCATION_ID;
        if (instanceRecordPath && instanceInvocationId) {
          try {
            await writeWorkspaceInstanceRecord(instanceRecordPath, {
              mainPid: process.pid,
              invocationId: instanceInvocationId,
            });
          } catch (error) {
            logger.warn("Workspace instance record write failed", {
              event: "daemon:instance_record_failed",
              error_message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      let agentProxy: ReturnType<typeof startAgentProxy> | undefined;
      try {
        if (process.platform === "linux" && config?.workspaceId)
          await reapLeftoverAgentProcesses(config.workspaceId, logger);
        const requireRuntime = (): DaemonRuntime => {
          if (!runtime) throw new Error("daemon runtime is not running");
          return runtime;
        };
        agentProxy = startAgentProxy({
          agentApiKeys: agentApiKeyRegistry(requireRuntime),
          runtime: daemonAgentProxyRuntime(requireRuntime),
          stateDirectory: daemonStateDirectory,
          cloudForward: {
            serverHttpUrl: () => config?.serverHttpUrl,
            daemonApiKey: () =>
              config
                ? credentials.load(config.workspaceId, config.computerId)
                : Promise.resolve(null),
          },
        });
        process.env.COFORGE_AGENT_PROXY_URL = agentProxy.url;
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
                new DaemonConnection(daemonConnectionEndpoint(COFORGE_DAEMON_SERVER_URL)),
            },
            agentProxy!,
            defaultCodeAgentDiscovery(daemonStateDirectory),
            daemonStateDirectory,
            {
              procMemoryConfigPath,
              recoveredRestartRequestIds:
                (config as { restartRequestIds?: string[] } | null)?.restartRequestIds ?? [],
              recoveredUpgradeRequestIds:
                (config as { upgradeRequestIds?: string[] } | null)?.upgradeRequestIds ?? [],
              recoveredUpgradeResults: upgradeOperationsInConfig(config).results,
              readUpgradeOperations: async () =>
                upgradeOperationsInConfig(await configStore.load()),
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
              readInstallerRecovery: () => installerRecoveryRequired(),
              requestUpgrade: (requestId, expectedVersion, releaseChannel) =>
                requestWorkspaceUpgrade(
                  config,
                  supervisorControl,
                  requestId,
                  expectedVersion,
                  releaseChannel,
                ),
            },
            computerVersion,
            undefined,
            undefined,
            releaseChannel,
          );
        const daemon = {
          async configure(connection: DaemonConfig) {
            const nextConfig = configStore.bindToServer(connection);
            if (nextConfig.workspaceId) await ensureBindingLock();
            const previousClaim = keyClaim;
            const nextClaim = await acquireClaimFor(nextConfig);
            const swappedClaim = nextClaim !== previousClaim;
            await runtime?.stop();
            config = nextConfig;
            if (swappedClaim) {
              previousClaim?.release();
              keyClaim = nextClaim;
            }
            const next = createRuntime(nextConfig);
            runtime = next;
            try {
              await parking.start(() => next.start(nextConfig));
            } catch (error) {
              if (swappedClaim && keyClaim === nextClaim) {
                keyClaim?.release();
                keyClaim = null;
              }
              throw error;
            }
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
          ...operatorRunnerPorts(
            () => runtime,
            () => config?.workspaceId,
          ),
        };
        await loginShellEnv;
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
          await healthJournal.recordGracefulStop();
          try {
            await daemon.stopAll();
          } finally {
            releaseLocks();
          }
          agentProxy?.close();
          await localRpc.close();
          logger.info("Daemon process stopped", { event: "daemon:stopped", outcome: "ok" });
          await dispose();
          resolveShutdown();
        };
        let resolveShutdown!: () => void;
        const shutdownRequested = new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        });
        void stopRequested.then(() => void shutdown());
        const parked = parking.bindShutdown(shutdown);
        try {
          await daemon.start();
        } catch (error) {
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
      } catch (error) {
        releaseLocks();
        agentProxy?.close();
        await dispose();
        throw error;
      }
    },
  );
}
