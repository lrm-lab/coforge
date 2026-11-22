import { beginLocalUpgradeProgress } from "#src/platform/computer-upgrade-progress";
import { resolveComputerInstallDirectory } from "#src/platform/computer-install-directory";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  RUNNER_HOLD_REASONS,
  type RunnerHoldReason,
  thrownMessage,
} from "@lrm/coforge-sdk/internal";
import { startDaemonLocalRpcServer, type DaemonHoldReport } from "#src/local-rpc";
import { captureStopSignal } from "#src/platform/stop-signal";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { createComputerSelfClient } from "#src/connection/computer-self-client";
import { runWorkspaceCommand, runnerCommandPort } from "./run-supervisor-command";
import { scheduleRetireSession } from "./retire-session";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import { LocalDaemonLauncher } from "#src/daemon-host/launcher";
import { acquireSupervisorLock } from "./supervisor-lock";
import {
  MachineSupervisor,
  UPGRADE_OPERATION_PENDING_TTL_MS,
  WorkspaceRecoveryError,
  type BindingStore,
} from "./machine-supervisor";
import { FileBindingStore } from "./binding-store";
import { dispose, getLogger, withContext } from "@logtape/logtape";
import { configureDaemonLogging } from "#src/platform/daemon-logging";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { platformWorkspaceInstance, workspaceInstanceConfig } from "./platform-workspace-instance";
import { workspaceUpgradeRecovery } from "./workspace-upgrade-recovery";
import { startWorkspaceReconcileLoop } from "./windows-workspace-reconcile";
import { workspaceStateDirectory, type WorkspaceInstance } from "./workspace-instance";
import { WorkspaceHealthJournal, workspaceHealthJournalPath } from "./workspace-health-journal";
import { askWorkspaceRunnerHold } from "./runner-hold";
import { workspaceDaemonConfig } from "./workspace-daemon-config";
import { startSupervisorWorkspace } from "./start-supervisor-workspace";
import { workspaceRuntimeView } from "./workspace-runtime-view";
import { WorkspaceAdoptions } from "./workspace-adoption";
import {
  awaitCloudConnections,
  OPERATOR_COMMAND_BUDGET_MS,
  readWorkspaceCloudConnection,
  workspaceSocketPath,
  type WorkspaceStartPorts,
} from "./workspace-start-outcome";
import { COFORGE_DAEMON_SERVER_URL } from "#src/connection/built-server";
import { launchComputerUpgrade } from "#src/platform/computer-upgrade-launcher";
import { sweepLeftoverComputerUpgradeJobs } from "#src/platform/computer-upgrade-sweep";
import { DaemonDiskJanitor } from "#src/platform/daemon-disk-janitor";
import { startLoginShellPathImport } from "./login-shell-path-import";
import { markStartup, startupTiming } from "#src/platform/startup-timing";
import {
  sweepComputerUpgradeReceipts,
  type ComputerUpgradeReceipt,
} from "#src/platform/computer-upgrade-receipts";
import { supervisorUpgradeReceipts } from "./supervisor-upgrade-receipts";
import { supervisorUpgradeDrainWatcher } from "./upgrade-drain-watcher";

export async function runMachineSupervisor(
  args: string[],
  createBindings: (stateDirectory: string) => BindingStore = (directory) =>
    new FileBindingStore(directory, COFORGE_DAEMON_SERVER_URL),
): Promise<void> {
  const socketPath = args[args.indexOf("--socket") + 1];
  if (!args.includes("--socket") || !socketPath) throw new Error("supervisor requires --socket");
  const stateDirectory = args.includes("--state-directory")
    ? args[args.indexOf("--state-directory") + 1]!
    : dirname(socketPath);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  markStartup("state_directory");
  await configureDaemonLogging(stateDirectory);
  try {
    await withContext(
      {
        service: "coforge-daemon",
        version: COFORGE_DAEMON_VERSION,
        process_role: "coordinator",
        pid: process.pid,
      },
      async () => {
        const lock = await acquireSupervisorLock(stateDirectory);
        markStartup("lock");
        const logger = getLogger(["coforge", "daemon", "supervisor"]);
        const loginShellPath = startLoginShellPathImport(stateDirectory);
        const diskJanitor = new DaemonDiskJanitor({
          stateDirectory,
          includeWorkspacesSubdir: true,
        });
        diskJanitor.start();
        try {
          logger.info("Coordinator process started", {
            event: "coordinator:started",
            ...startupTiming(),
          });
          // Windows: do not await — accumulated upgrade receipts drove serial schtasks /Delete calls past the 10s handshake budget.
          const leftoverSweep = sweepLeftoverComputerUpgradeJobs({
            platform: process.platform,
            stateDirectory,
          }).catch((error) =>
            logger.error("Leftover Computer upgrade job sweep failed", {
              event: "upgrade:leftover_job_sweep_failed",
              error_message: thrownMessage(error),
            }),
          );
          if (process.platform !== "win32") await leftoverSweep;
          await runWithSupervisorLock(socketPath, stateDirectory, createBindings(stateDirectory));
        } finally {
          diskJanitor.stop();
          await loginShellPath.stop();
          lock.release();
          logger.info("Coordinator process stopped", { event: "coordinator:stopped" });
        }
      },
    );
  } finally {
    await dispose();
  }
}

async function runWithSupervisorLock(
  socketPath: string,
  stateDirectory: string,
  bindings: BindingStore,
): Promise<void> {
  const stopRequested = captureStopSignal();
  const lockMarker = join(stateDirectory, "supervisor.lock");
  await mkdir(lockMarker, { recursive: true, mode: 0o700 });
  await writeFile(join(lockMarker, "owner"), String(process.pid), { mode: 0o600 });
  const workspaceDirectory = (id: string) => workspaceStateDirectory(stateDirectory, id);
  const installRoot = resolveComputerInstallDirectory();
  const upgradeRecovery = await workspaceUpgradeRecovery(
    installRoot,
    COFORGE_DAEMON_VERSION,
    performance.timeOrigin,
  );
  const workspaceHealth = (id: string) =>
    new WorkspaceHealthJournal(workspaceHealthJournalPath(workspaceDirectory(id)));
  const startPorts: WorkspaceStartPorts = {
    async parkReason(id) {
      const health = await workspaceHealth(id).state();
      return health.status === "parked" ? health.reason : undefined;
    },
    cloudConnection: (id) => readWorkspaceCloudConnection(stateDirectory, id),
  };
  const childClient = (workspaceId: string) =>
    new LocalDaemonLauncher({
      executablePath: process.execPath,
      socketPath: workspaceSocketPath(stateDirectory, workspaceId),
      spawn: () => {},
    });
  const workspaceInstance = (workspaceId: string): WorkspaceInstance =>
    platformWorkspaceInstance(
      workspaceInstanceConfig(stateDirectory, socketPath, workspaceId, {
        platform: process.platform,
        homeDirectory: homedir(),
        executablePath: process.execPath,
        daemonConnectionEndpoint: Bun.env.COFORGE_DAEMON_CONNECTION_ENDPOINT,
      }),
      process.platform,
    );
  const supervisorLogger = getLogger(["coforge", "daemon", "supervisor"]);
  const adoptions = new WorkspaceAdoptions({
    instance: workspaceInstance,
    handshake: (workspaceId, timeoutMs) => childClient(workspaceId).identity(timeoutMs),
  });
  const holdWorkspaceRunners = (
    workspaceId: string,
    operation: "hold" | "release",
    reason: RunnerHoldReason | undefined,
    eventPrefix: string,
    timeoutMs?: number,
  ) =>
    askWorkspaceRunnerHold({
      workspaceId,
      operation,
      reason,
      eventPrefix,
      timeoutMs,
      hold: (operation, reason) => childClient(workspaceId).hold(operation, reason),
    });
  /**
   * Read-only settle check for `MachineSupervisor.recordUpgrade`'s blocking pending operation: a
   * receipt already on disk, or the pending TTL already passed, settles it right there instead of
   * refusing the new request. Captures the answer through `sweepComputerUpgradeReceipts`'
   * `complete` callback rather than calling back into the supervisor - this runs inside
   * `recordUpgrade`'s own serialized mutation, where `supervisor.completeUpgrade` would deadlock.
   */
  const settlePendingUpgrade = async (
    workspaceId: string,
    requestId: string,
    requestedAt: number,
  ) => {
    let settlement: ComputerUpgradeReceipt | undefined;
    await sweepComputerUpgradeReceipts(
      [{ workspaceId, requestId, requestedAt }],
      async (_workspaceId, _requestId, receipt) => {
        settlement = receipt;
      },
      { pendingTtlMs: UPGRADE_OPERATION_PENDING_TTL_MS },
    );
    return settlement;
  };
  /** Rewrites one already-running Workspace's config file with its binding's current upgrade
   * state, without restarting it; a running child polls it while it lists a pending operation.
   * Best-effort: a Workspace never started (no directory yet) or whose write fails picks it up at
   * its next real start. */
  const refreshChildUpgradeConfig = async (workspaceId: string): Promise<void> => {
    try {
      const binding = (await supervisor.snapshot()).find(
        (entry) => entry.workspaceId === workspaceId,
      );
      if (!binding) return;
      await new DaemonConfigStore(workspaceDirectory(workspaceId)).save(
        workspaceDaemonConfig(binding),
      );
    } catch (error) {
      supervisorLogger.warn("Refreshing a Workspace's local upgrade config failed", {
        event: "upgrade:child_config_refresh_failed",
        workspace_id: workspaceId,
        error_message: thrownMessage(error),
      });
    }
  };
  // Stable OS units own processes even if the Coordinator died before readiness.
  // Recovery adopts them through MainPID + the daemon handshake, never by killing PIDs.
  const supervisor = new MachineSupervisor(
    bindings,
    {
      start: startSupervisorWorkspace({
        workspaceDirectory,
        workspaceHealth,
        supervisorLogger,
        workspaceInstance,
        adoptions,
        startPorts,
        upgradeRecovery,
      }),
      async stop(binding, preserve) {
        await upgradeRecovery.discard(binding.workspaceId, preserve);
        const child = adoptions.get(binding.workspaceId);
        // Includes recovery after enabled=false was persisted but OS stop was interrupted.
        // systemd sends SIGTERM to the Workspace main, then kills residual cgroup members.
        await (child?.instance ?? workspaceInstance(binding.workspaceId)).stop();
        adoptions.forget(binding.workspaceId);
      },
      async instance(binding) {
        const observed = await workspaceInstance(binding.workspaceId).identity();
        // Require `active`: a durable Windows record can keep mainPid after death; treating that
        // as the live instance would skip ensureStarted and leave the Workspace down. A read only
        // observes: an adopted child that reads as gone stays recorded and simply no longer
        // matches the live instance, so one misread cannot drop a Workspace that is still up.
        return observed?.active ? observed.invocationId : null;
      },
      // Per-Workspace, so a restart never reaches past its own target: an unscoped restart holds
      // each enabled binding in turn as the loop gets to it, not the whole machine at once. The
      // Coordinator-wide fan-out below stays the upgrade's path.
      hold: (binding, reason) =>
        holdWorkspaceRunners(binding.workspaceId, "hold", reason, "restart"),
      release: (binding, reason) =>
        holdWorkspaceRunners(binding.workspaceId, "release", reason, "restart"),
      clearHealth: (binding) => workspaceHealth(binding.workspaceId).clear(),
      parkedReason: (binding) => startPorts.parkReason(binding.workspaceId),
      clearParked: (binding) => workspaceHealth(binding.workspaceId).clearParked(),
    },
    Date.now,
    {},
    settlePendingUpgrade,
  );
  const scopedCredentials = (workspaceId: string) =>
    new FileDaemonCredentialStore(workspaceDirectory(workspaceId));
  /**
   * An operator start or restart answers under one deadline for the whole command: every
   * Workspace it started is answered with where its first cloud connect stands, one still under
   * way (queued, holding, stopping, or starting) with `lifecycleUnderWay` while its work finishes
   * behind the answer, and one the cloud refused for good refuses the command with its park.
   */
  const startForOperator = async (
    operation: "start" | "restart",
    workspaceId: string | undefined,
    requestId: string,
  ) => {
    const deadline = Date.now() + OPERATOR_COMMAND_BUDGET_MS;
    const { started, pending } = await supervisor.command(
      operation,
      workspaceId,
      operation === "restart" ? requestId : undefined,
      { deadline },
    );
    // Only finished Workspaces are asked: one still restarting may be answered by its old process.
    const outcomes = await awaitCloudConnections(startPorts, started, deadline);
    const answered = new Map(outcomes.map((outcome) => [outcome.workspaceId, outcome]));
    return (await runtimes(await supervisor.view())).map((runtime) => {
      if (pending.includes(runtime.workspaceId)) return { ...runtime, lifecycleUnderWay: true };
      const outcome = answered.get(runtime.workspaceId);
      if (!outcome) return runtime;
      return {
        ...runtime,
        cloudConnection: outcome.cloudConnection,
        ...(outcome.error ? { cloudConnectionError: outcome.error } : {}),
      };
    });
  };
  /** Each binding's live identity, or processId 0 while its OS instance is gone, plus why it is
   * parked, when it is. */
  const runtimes = async (
    bindings:
      | Awaited<ReturnType<typeof supervisor.snapshot>>
      | Promise<Awaited<ReturnType<typeof supervisor.snapshot>>>,
  ) =>
    Promise.all(
      (await bindings).map(async (binding) => {
        await adoptions.adoptLive(binding);
        return workspaceRuntimeView(
          binding,
          adoptions.get(binding.workspaceId),
          startPorts.parkReason,
        );
      }),
    );
  const upgradeReceipts = supervisorUpgradeReceipts(
    supervisor,
    supervisorLogger,
    refreshChildUpgradeConfig,
  );
  const {
    completeUpgrade,
    pendingUpgradeOperations,
    settlePendingUpgradeOperations,
    watchPendingUpgrade,
  } = upgradeReceipts;
  /** The pending `retire-session` per Workspace — a new start for the same one cancels the one
   * it left, and the Coordinator's shutdown cancels them all (task #417). */
  const retireSessions = new Map<string, { stop(): void }>();
  const fanOutRunnerHold = async (
    operation: "hold" | "release",
    reason?: RunnerHoldReason,
    options?: { timeoutMs?: number; workspaceIds?: readonly string[]; eventPrefix?: string },
  ): Promise<DaemonHoldReport> => {
    const workspaceIds =
      options?.workspaceIds ??
      (await runtimes(await supervisor.view()))
        .filter((runtime) => runtime.processId > 0)
        .map((runtime) => runtime.workspaceId);
    const eventPrefix =
      options?.eventPrefix ??
      (reason === RUNNER_HOLD_REASONS.COMPUTER_UPGRADE ? "upgrade" : "restart");
    const reports = await Promise.all(
      workspaceIds.map((workspaceId) =>
        holdWorkspaceRunners(workspaceId, operation, reason, eventPrefix, options?.timeoutMs),
      ),
    );
    return {
      held: operation === "hold",
      busyAgents: reports.flatMap((report) => report.busyAgents),
      unreachableWorkspaceIds: reports.flatMap((report) => report.unreachableWorkspaceIds),
    };
  };
  let rpc: Awaited<ReturnType<typeof startDaemonLocalRpcServer>> | undefined;
  try {
    try {
      await supervisor.recover();
    } catch (error) {
      if (!(error instanceof WorkspaceRecoveryError)) throw error;
      getLogger(["coforge", "daemon", "supervisor"]).error(
        "Workspace recovery incomplete: {error}",
        { error },
      );
    }
    await settlePendingUpgradeOperations();
    for (const operation of await pendingUpgradeOperations())
      watchPendingUpgrade(operation.workspaceId, operation.requestId, operation.requestedAt);
    const workspaceReconcile = startWorkspaceReconcileLoop(
      (workspaceIds) => supervisor.reconcile(workspaceIds),
      {
        pendingUpgradeWorkspaces: () => upgradeRecovery.pendingWorkspaceIds(),
        onError: (error) => {
          if (error instanceof WorkspaceRecoveryError) {
            supervisorLogger.error("Workspace reconcile incomplete: {error}", { error });
            return;
          }
          supervisorLogger.error("Workspace reconcile failed", {
            event: "workspace:windows_reconcile_failed",
            error_message: thrownMessage(error),
          });
        },
      },
    );
    const upgradeDrainWatcher = supervisorUpgradeDrainWatcher({
      stateDirectory,
      installRoot,
      runtimes: () => runtimes(supervisor.view()),
      fanOut: fanOutRunnerHold,
    });
    upgradeDrainWatcher.start();
    try {
      rpc = await startDaemonLocalRpcServer({
        socketPath,
        version: COFORGE_DAEMON_VERSION,
        validateCredential: async (value) => value.length > 0,
        credentials: {
          load: (w, c) => scopedCredentials(w).load(w, c),
          save: (w, c, key) => scopedCredentials(w).save(w, c, key),
          delete: (w, c) => scopedCredentials(w).delete(w, c),
        },
        runtime: {
          configure: async (config, options) => {
            const { pending } = await supervisor.configure(config, {
              deadline: Date.now() + OPERATOR_COMMAND_BUDGET_MS,
            });
            if (!pending && config.serverHttpUrl && options?.loginSetup) {
              retireSessions.get(config.workspaceId)?.stop();
              retireSessions.set(
                config.workspaceId,
                scheduleRetireSession({
                  selfClient: createComputerSelfClient(config.serverHttpUrl),
                  credentials: new FileDaemonCredentialStore(
                    workspaceDirectory(config.workspaceId),
                  ),
                  workspaceId: config.workspaceId,
                  computerId: config.computerId,
                  serverHttpUrl: config.serverHttpUrl,
                }),
              );
            }
            return pending ? { lifecycleUnderWay: true } : {};
          },
          hold: (reason) => fanOutRunnerHold("hold", reason),
          release: () => fanOutRunnerHold("release"),
          command: (method, request) =>
            runWorkspaceCommand({
              method,
              request,
              supervisor,
              ownServerUrl: COFORGE_DAEMON_SERVER_URL,
              workspaceDirectory,
              stateDirectory,
              refreshChildUpgradeConfig,
              completeUpgrade,
              watchPendingUpgrade,
              launchComputerUpgrade,
              beginUpgradeProgress: (workspaceId, requestId, version) =>
                beginLocalUpgradeProgress(installRoot, workspaceId, requestId, version),
              makeSelfClient: createComputerSelfClient,
              view: () => runtimes(supervisor.view()),
              startForOperator,
              runnerCommand: runnerCommandPort({
                observe: () => runtimes(supervisor.view()),
                childClient,
              }),
            }),
        },
      });
      await stopRequested;
    } finally {
      upgradeDrainWatcher.stop();
      workspaceReconcile?.stop();
    }
  } finally {
    await upgradeReceipts.stop();
    for (const session of retireSessions.values()) session.stop();
    retireSessions.clear();
    let cleaned = false;
    try {
      if (rpc) await supervisor.shutdown();
      cleaned = true;
    } finally {
      await rpc?.close();
      if (cleaned) await rm(join(lockMarker, "owner"), { force: true });
    }
  }
}
