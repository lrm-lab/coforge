import type { CredentialInvalidHolds } from "./credential-invalid-holds";
import { getLogger } from "@logtape/logtape";
import { mkdirSync } from "node:fs";
import type { RuntimeAuthAdapter, RuntimeAuthProvider } from "@lrm/coforge-anvil";
import {
  WORKSPACE_PROTOCOL_MAJOR,
  diagnosticErrorCode,
  type AgentWorkspaceDeleteRequest,
  type AgentWorkspaceDeleteResult,
  type DaemonConnectRejectionReason,
  type RuntimeProvider,
  type UsageScanResponse,
} from "@lrm/coforge-sdk/internal";
import type { PiChatFrame } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { COFORGE_DAEMON_VERSION } from "#src/version";
import { createComputerSelfClient } from "#src/connection/computer-self-client";
import { migrateComputerKey } from "#src/daemon-runtime/computer-key-migration";
import type {
  DaemonCredentialConfirmations,
  DaemonCredentialStore,
} from "#src/credentials/credential-store";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import { DaemonConnectionRefusedError } from "#src/connection/daemon-connection-refused-error";
import { DaemonConnectionStoppedError } from "#src/connection/daemon-connection-stopped-error";
import { PiChatRelay } from "#src/pi-chat/relay";
import type { AgentControl } from "#src/agent-runtime/agent-control";
import type { AgentSessions } from "#src/agent-runtime/agent-session";
import type { OperatingSystemInfo } from "#src/platform/operating-system";
import type { DaemonConfig } from "./runtime";
import type { AgentConfigApply } from "./agent-config-apply";
import type { AgentWorkspaceQueries } from "./agent-workspace-queries";
import type { CodeAgentInventorySync } from "./code-agent-inventory-sync";
import type { RuntimeAuthReporter } from "./runtime-auth-reporter";
import type { RuntimeAuthController } from "./runtime-auth-controller";
import type { UpgradeResultReporter } from "./upgrade-result-reporter";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { ActivityLaunch } from "./activity-launch";
import type { RuntimeSweeps } from "./runtime-sweeps";
import type { runtimeMachineStatus } from "./machine-status-reporter";
import type { ProcJobManager } from "#src/proc-jobs/proc-job-manager";
import { readyCapabilities } from "./ready-capabilities";
import { RuntimeReadyWaitWatch } from "./runtime-ready-wait";
import { subscribeRuntimeAuth } from "./runtime-auth-subscription";
import { subscribeRuntimeReconnect } from "./runtime-reconnect";
import type { ReminderDueReceiver } from "#src/agent-reminder/reminder-due-receiver";
import { subscribeProviderScans } from "./provider-scan-handlers";
import type { ResetCreditConsumeResult } from "./reset-credit-consume";
import { subscribeWorkspaceQueries } from "./workspace-query-handlers";
import { subscribeContextViewQueries } from "./context-view-query-handlers";
import type { ProviderQuotaState } from "./provider-quota-state";
import { subscribeAgentSideAskQueries, type AgentSideAskSource } from "./agent-side-ask-handler";
import { RuntimeManageRunner, subscribeRuntimeManageQueries } from "./runtime-manage-handler";
import { SideQuestionRunner } from "#src/agent-runtime/agent-side-ask";
import type { AgentContextViewService } from "#src/agent-context-view/agent-context-view-service";
import type { ContextViewIndexEntry } from "#src/agent-context-view/context-view-store";
import {
  RuntimePublicationSubscriptions,
  type RuntimePublicationSubscriptionPorts,
} from "./runtime-publication-subscriptions";
import { unsubscribeAll } from "./runtime-transport-lifecycle";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type RuntimeStartupPorts = {
  transport: () => DaemonConnectionClient;
  replaceTransport: () => Promise<unknown>;
  credentials: Pick<DaemonCredentialStore, "load" | "save"> &
    Partial<DaemonCredentialConfirmations>;
  runtimeInstanceId: string;
  startedAtMs: number;
  computerVersion?: string;
  releaseChannel?: string;
  isStopping: () => boolean;
  publications: Omit<
    RuntimePublicationSubscriptionPorts,
    "transport" | "workspaceId" | "computerId"
  >;
  agentControl: Pick<AgentControl, "replay">;
  agentSessions: Pick<AgentSessions, "replay">;
  configApply: Pick<AgentConfigApply, "appliedRevisions">;
  readyRunningAgentIds(): string[];
  operatingSystem: Pick<OperatingSystemInfo, "read" | "current">;
  upgradeResults: Pick<UpgradeResultReporter, "start" | "report" | "stop">;
  runtimeAuth: Pick<RuntimeAuthReporter, "refresh" | "refreshProvider" | "usageScanned">;
  credentialHolds: Pick<CredentialInvalidHolds, "signedIn" | "isHeld">;
  runtimeAuthFactory: (provider: RuntimeAuthProvider) => RuntimeAuthAdapter;
  codeAgentInventory: Pick<
    CodeAgentInventorySync,
    "reportRuntimes" | "refreshStaleCatalogs" | "refreshModels" | "readCommandCodeEfforts"
  >;
  scanUsage(provider: RuntimeProvider): Promise<UsageScanResponse>;
  consumeResetCredit(
    provider: RuntimeProvider,
    idempotencyKey: string,
  ): Promise<ResetCreditConsumeResult>;
  workspaceQueries: Pick<AgentWorkspaceQueries, "listSkills" | "listFiles" | "readFile" | "scan">;
  stateDirectory: string;
  contextView: Pick<AgentContextViewService, "find">;
  sideAsk?: AgentSideAskSource;
  quotaState?: Pick<ProviderQuotaState, "summaryForAgent">;
  agentApiKey(agentId: string): string | undefined;
  resolveProviderSource?(agentId: string, entry: ContextViewIndexEntry): string | undefined;
  deleteWorkspace(
    request: AgentWorkspaceDeleteRequest,
  ): Promise<Pick<AgentWorkspaceDeleteResult, "status">>;
  sendPiChatFrame?(frame: PiChatFrame): Promise<void>;
  lifecycle: {
    requestRestart?(requestId: string): Promise<void>;
    requestUpgrade?(
      requestId: string,
      expectedVersion?: string,
      releaseChannel?: string,
    ): Promise<void>;
    connectionRefused?(reason: DaemonConnectRejectionReason): void;
    recoveredRestartRequestIds?: string[];
    recoveredUpgradeRequestIds?: string[];
  };
  reminders: Pick<ReminderDueReceiver, "restore">;
  resyncAppConfigs(): void;
  activityPublisher: Pick<AgentActivityPublisher<ActivityLaunch>, "enable" | "lastBusy">;
  sweeps: Pick<RuntimeSweeps, "start">;
  machineStatus: Pick<ReturnType<typeof runtimeMachineStatus>, "start">;
  procJobs?: Pick<ProcJobManager, "startSweep" | "purgeWorkspace">;
};

export class RuntimeStartup {
  #promise: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #started = false;
  #subscriptions: Array<() => void> = [];
  #piChat?: PiChatRelay;
  #sideAsk?: SideQuestionRunner;
  #runtimeManage?: RuntimeManageRunner;
  #authControl: RuntimeAuthController | undefined;
  #readyWait: RuntimeReadyWaitWatch | undefined;
  #publications: RuntimePublicationSubscriptions | undefined;

  constructor(private readonly ports: RuntimeStartupPorts) {}

  get started(): boolean {
    return this.#started;
  }

  pending(): Promise<void> | undefined {
    return this.#promise;
  }

  start(connection: DaemonConfig): Promise<void> {
    if (this.#started) return Promise.resolve();
    if (this.#promise) return this.#promise;
    const abort = new AbortController();
    this.#abort = abort;
    this.#promise = this.#open(connection, abort.signal).finally(() => {
      this.#promise = undefined;
      this.#abort = undefined;
    });
    return this.#promise;
  }

  close(): Promise<void> {
    this.#readyWait?.settle();
    this.#started = false;
    this.#authControl?.stop();
    this.#authControl = undefined;
    this.#sideAsk?.stopAll();
    this.#sideAsk = undefined;
    this.#runtimeManage?.stopAll();
    this.#runtimeManage = undefined;
    const piChat = this.#piChat;
    this.#piChat = undefined;
    const piChatClosed = piChat?.close();
    return piChatClosed ?? Promise.resolve();
  }

  unsubscribeAll(): void {
    unsubscribeAll(this.#subscriptions);
  }

  abort(): void {
    this.#readyWait?.settle();
    this.#abort?.abort(new DaemonConnectionStoppedError());
  }

  #subscribe(unsubscribe: (() => void) | undefined): void {
    if (unsubscribe) this.#subscriptions.push(unsubscribe);
  }

  #restoreReminderDues(): void {
    void this.ports.reminders.restore();
  }

  async #open(connection: DaemonConfig, signal: AbortSignal): Promise<void> {
    const { ports } = this;
    mkdirSync(connection.workspaceRoot, { recursive: true });
    const stored = await ports.credentials.load(connection.workspaceId, connection.computerId);
    if (!stored) throw new Error("Workspace credential is missing");
    // The stored dk_ migrates to the Computer's own sk_computer (task #417): saved before it is
    // confirmed, so a failure leaves the old key live and the connection still opens with it.
    const token = await migrateComputerKey({
      credentials: ports.credentials,
      client: connection.serverHttpUrl
        ? createComputerSelfClient(connection.serverHttpUrl)
        : undefined,
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
      apiKey: stored,
      signal,
    });
    const publications = new RuntimePublicationSubscriptions({
      ...ports.publications,
      purgeProcJobs: ports.procJobs ? () => ports.procJobs!.purgeWorkspace() : undefined,
      transport: ports.transport(),
      workspaceId: connection.workspaceId,
      computerId: connection.computerId,
    });
    try {
      const auth = subscribeRuntimeAuth(ports.transport(), {
        owner: {
          protocolMajor: 1,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
        },
        workingDirectory: connection.workspaceRoot,
        createAdapter: ports.runtimeAuthFactory,
        refresh: (options) => ports.runtimeAuth.refresh(options),
        refreshProvider: (provider, options) =>
          ports.runtimeAuth.refreshProvider(provider, options),
      });
      this.#authControl = auth?.controller;
      this.#subscribe(
        auth?.controller.onSignedIn((provider) => ports.credentialHolds.signedIn(provider)),
      );
      this.#subscribe(auth?.unsubscribe);
      ports.upgradeResults.start();
      this.#subscribe(
        subscribeRuntimeReconnect(ports.transport(), {
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          refreshInventory: (transport) => {
            void ports.codeAgentInventory
              .reportRuntimes(transport)
              .then((report) => ports.codeAgentInventory.refreshStaleCatalogs(report, transport))
              .catch(() => {});
          },
          restoreReminderDues: () => this.#restoreReminderDues(),
          resyncAppConfigs: () => ports.resyncAppConfigs(),
          replayAgentControl: () => ports.agentControl.replay(),
          replayAgentSessions: () => ports.agentSessions.replay(),
          reportUpgradeResults: () => ports.upgradeResults.report(),
        }),
      );
      const transport = ports.transport();
      this.#piChat ??= new PiChatRelay(connection, async (frame) => {
        if (ports.sendPiChatFrame) return ports.sendPiChatFrame(frame);
        const live = ports.transport();
        if (ports.isStopping() || !live.sendPiChatFrame)
          throw new Error("Pi chat connection unavailable");
        await live.sendPiChatFrame(frame);
      });
      this.#subscribe(
        transport.onPiChatRequest?.(async (request) => {
          if (
            ports.isStopping() ||
            request.workspaceId !== connection.workspaceId ||
            request.computerId !== connection.computerId
          )
            return;
          await this.#piChat?.execute(request);
        }),
      );
      for (const unsubscribe of subscribeWorkspaceQueries(transport, {
        connection,
        observations: ports.workspaceQueries,
        deleteWorkspace: (request) => ports.deleteWorkspace(request),
        currentTransport: () => ports.transport(),
        isStopping: () => ports.isStopping(),
      }))
        this.#subscribe(unsubscribe);
      this.#subscribe(
        subscribeContextViewQueries(transport, {
          connection,
          stateDirectory: ports.stateDirectory,
          contextView: ports.contextView,
          agentApiKey: ports.agentApiKey,
          resolveProviderSource: ports.resolveProviderSource,
          currentTransport: () => ports.transport(),
          isStopping: () => ports.isStopping(),
        }),
      );
      if (ports.sideAsk) {
        this.#sideAsk ??= new SideQuestionRunner();
        const runner = this.#sideAsk;
        this.#subscribe(ports.sideAsk.onRuntimeEnd((agentId) => runner.stopForAgent(agentId)));
        this.#subscribe(
          subscribeAgentSideAskQueries(transport, {
            connection,
            source: ports.sideAsk,
            activityPublisher: ports.activityPublisher,
            credentialHolds: ports.credentialHolds,
            quotaState: ports.quotaState,
            runner,
            currentTransport: () => ports.transport(),
            isStopping: () => ports.isStopping(),
          }),
        );
      }
      this.#runtimeManage ??= new RuntimeManageRunner({
        cacheDirectory: ports.stateDirectory,
        rescan: async () => {
          const live = ports.transport();
          if (ports.isStopping()) return;
          const report = await ports.codeAgentInventory.reportRuntimes(live);
          void ports.codeAgentInventory.refreshStaleCatalogs(report, live).catch(() => {});
        },
      });
      this.#subscribe(
        subscribeRuntimeManageQueries(transport, {
          connection,
          runner: this.#runtimeManage,
          currentTransport: () => ports.transport(),
          isStopping: () => ports.isStopping(),
        }),
      );
      for (const unsubscribe of subscribeProviderScans(transport, {
        connection,
        runtime: {
          scanUsage: (provider) => ports.scanUsage(provider),
          consumeResetCredit: (provider, key) => ports.consumeResetCredit(provider, key),
        },
        currentTransport: () => ports.transport(),
        isStopping: () => ports.isStopping(),
        runtimeAuth: ports.runtimeAuth,
        inventory: ports.codeAgentInventory,
      }))
        this.#subscribe(unsubscribe);
      for (const unsubscribe of await publications.install()) this.#subscribe(unsubscribe);
      this.#publications = publications;
      this.#readyWait ??= new RuntimeReadyWaitWatch({
        heldCount: () => this.#publications?.heldCount() ?? 0,
      });
      this.#readyWait.begin(connection.workspaceId);
      await transport.start(token, {
        workspaceId: connection.workspaceId,
        computerId: connection.computerId,
        workerInstanceId: ports.runtimeInstanceId,
        startedAt: ports.startedAtMs,
        serverHttpUrl: connection.serverHttpUrl,
        requestRestart: ports.lifecycle.requestRestart,
        requestUpgrade: ports.lifecycle.requestUpgrade,
        signal,
      });
      await ports.agentControl.replay();
      await ports.agentSessions.replay();
      await ports.operatingSystem.read();
      await transport.ready(() => {
        this.#readyWait?.attempt();
        const runningAgentIds = ports.readyRunningAgentIds();
        const revisions = ports.configApply.appliedRevisions();
        const appliedAgentConfigs = runningAgentIds.flatMap((agentId) => {
          const revision = revisions.get(agentId);
          return revision === undefined ? [] : [{ agentId, revision }];
        });
        return {
          protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
          requestId: crypto.randomUUID(),
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          workerInstanceId: ports.runtimeInstanceId,
          startedAt: ports.startedAtMs,
          runningAgentIds,
          ...(appliedAgentConfigs.length ? { appliedAgentConfigs } : {}),
          daemonVersion: COFORGE_DAEMON_VERSION,
          computerVersion: ports.computerVersion,
          releaseChannel: ports.releaseChannel,
          ...ports.operatingSystem.current,
          recoveredRestartRequestIds: ports.lifecycle.recoveredRestartRequestIds ?? [],
          recoveredUpgradeRequestIds: ports.lifecycle.recoveredUpgradeRequestIds ?? [],
          capabilities: readyCapabilities(!!ports.publications.migration, !!this.#authControl),
        };
      }, signal);
      await ports.upgradeResults.report();
      this.#restoreReminderDues();
      ports.resyncAppConfigs();
      const { buffered, dropped } = publications.release();
      this.#readyWait?.settle();
      if (dropped > 0)
        logger.warn("Delivery notices held during start were dropped; the cloud resends them", {
          event: "daemon_runtime:notices_dropped",
          dropped,
        });
      this.#started = true;
      ports.activityPublisher.enable();
      ports.sweeps.start();
      ports.machineStatus.start();
      ports.procJobs?.startSweep();
      const codeAgentReport = ports.codeAgentInventory.reportRuntimes(transport);
      await Promise.all(buffered.map((flush) => flush()));
      void codeAgentReport
        .then((report) => ports.codeAgentInventory.refreshStaleCatalogs(report, transport))
        .catch(() => {});
    } catch (error) {
      this.#authControl?.stop();
      this.#authControl = undefined;
      this.#sideAsk?.stopAll();
      this.#sideAsk = undefined;
      this.#runtimeManage?.stopAll();
      this.#runtimeManage = undefined;
      this.unsubscribeAll();
      ports.upgradeResults.stop();
      this.#started = false;
      // A connection left up keeps reporting this Computer online for a Workspace that never
      // started, so a failed start takes its transport down too.
      if (
        error instanceof DaemonConnectionRefusedError &&
        (error.reason === "workspace_deleted" || error.reason === "computer_unlinked")
      )
        await ports.procJobs?.purgeWorkspace().catch(() => {});
      const stopError = await ports.replaceTransport();
      if (stopError !== undefined)
        logger.warn("Stopping the connection of a failed start failed", {
          event: "daemon_runtime:failed_start_stop_failed",
          error_code: diagnosticErrorCode(stopError),
        });
      throw error;
    }
  }
}
