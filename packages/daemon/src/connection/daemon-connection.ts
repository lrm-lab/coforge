import type {
  DaemonConnectionConfig,
  DaemonConnectionClient,
  ReceivedAgentMigrationLease,
} from "./daemon-connection-client";
import { ownedIntent } from "./owned-intent";
import {
  type AgentContextViewResult,
  type AgentServerFeatures,
  type AppConfigSync,
  type RuntimeAuthIntent,
  type RuntimeAuthLoginReport,
  type RuntimeAuthLogoutReport,
} from "@lrm/coforge-sdk/internal";
import { disconnectedCodes } from "centrifuge/build/protobuf";
import {
  type CentrifugeWorkspaceClient,
  type CentrifugeWorkspaceClientFactory,
  defaultCentrifugeWorkspaceClientFactory,
} from "./centrifuge-workspace-client";
import { daemonConnectHeaders } from "./daemon-connect-headers";
import {
  encodeAgentReplyIntent,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";
import { ListenerSlot } from "./listener-slot";
import { ServerPublications } from "./server-publications";
import { routePublication } from "./publication-routing";
import {
  defaultDaemonConnectionTiming,
  type DaemonConnectionTiming,
} from "./daemon-connection-timing";
import { DaemonNoticePublications } from "./daemon-notice-publications";
import { DaemonProviderPublications } from "./daemon-provider-publications";
import { rpcData } from "./rpc-data";
import { serverEndpoint } from "./daemon-endpoints";
import { DaemonQueries } from "./daemon-queries";
import { routeRuntimeAuthPublication } from "./runtime-auth-publication";
import { DaemonConnectionAgentHttp, type AgentHttpDeps } from "./daemon-connection-agent-http";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import { DaemonConnectionRefusedError } from "./daemon-connection-refused-error";
import { DaemonConnectionStoppedError } from "./daemon-connection-stopped-error";
import { ReadyPublicationHold } from "./ready-publication-hold";
import { InboundQuietness, LostClientRebuild } from "./connection-liveness";
import { reportDaemonOnline } from "./connection-status-payload";
import {
  sendDaemonReady,
  sendCodeAgentsUpdate,
  sendRuntimeAuthLogin,
  sendRuntimeAuthLogout,
  sendRuntimeAuthStatus,
} from "./daemon-ready-send";
import { AgentObservationPublisher, publishAgentActivity } from "./agent-observation-publisher";
import { postAgentContextViewResult } from "./agent-context-view-upload";
import {
  daemonConnectRejectionReason,
  type DaemonConnectRejectionReason,
  decodeAgentWorkspaceResetRequest,
  encodeAgentControlResult,
  encodeAgentTurnInterruptResult,
  encodeAgentSessionInvalidate,
  AGENT_CONTROL_RESULT_METHOD,
  AGENT_TURN_INTERRUPT_RESULT_METHOD,
  AGENT_SESSION_INVALIDATE_METHOD,
  type AgentWorkspaceResetRequest,
  type AgentControlResult,
  type AgentTurnInterruptResult,
  type AgentSessionReport,
  type AgentSessionInvalidate,
  type AgentContextUsage,
  type AgentTokenUsage,
  type AgentServiceTier,
  type AgentContextViewAvailability,
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentTurnInterruptIntent,
  decodeAgentActivityProbe,
  decodeAgentInboxPurge,
  type ComputerUpgradeResult,
  decodeAgentMessageDelivery,
  encodeAgentActivity,
  encodeAgentStatus,
  type AgentCredentialRestored,
  type AgentMentionDeliveryTransition,
  type AgentMentionDeliveryTerminalError,
  type MachineStatusReport,
  type RuntimeAuthStatusReport,
  type DaemonRuntimeShutdown,
  AGENT_STATUS_METHOD,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeCodeAgentsUpdateRequest,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
  type DaemonRuntimeResetCreditConsumeRequest,
  type DaemonRuntimeResetCreditConsumeResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
  type DaemonRuntimeCommandCodeEffortReadRequest,
  type DaemonRuntimeCommandCodeEffortReadResponse,
  type AgentActivity,
  type AgentStatus,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentStaleRuntimeStop,
  type AgentConfigSync,
  type AgentTurnInterruptIntent,
  type AgentActivityProbe,
  type AgentInboxPurge,
  type AgentMessageDelivery,
  type AgentMessageDeliveryAck,
  type AgentMessageDeliveryRejection,
  type AgentMessageRequest,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  REMINDER_DUE_ACK_METHOD,
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeReminderDueAckResponse,
  decodeReminderSync,
  decodeAgentMigrationCancel,
  decodeAgentMigrationLease,
  encodeReminderDueAckRequest,
  type AgentReminderOperationRequest,
  type ReminderDue,
  type ReminderDueAckRequest,
  APP_CONFIG_SNAPSHOT_METHOD,
  decodeAppConfigSync,
  encodeAppConfigSnapshotRequest,
  type AppConfigSnapshotRequest,
  type AgentMigrationCancel,
} from "@lrm/coforge-sdk/internal";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import {
  decodeAppRegistrationNotice,
  type AppRegistrationNotice,
} from "@lrm/coforge-sdk/internal/app-registration-notice";
import { RejectedControl } from "./control-rejection-log";
import { sendShutdownNoticeOver } from "./shutdown-notice";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "./shutdown-notice-timeout";
import { reportAgentSessionWithRetry } from "./agent-session-report";
import { getLogger } from "@logtape/logtape";
import { AGENT_RPC_TIMEOUT_MS } from "./agent-http-wire";
import { AgentMigrationHttpClient } from "./agent-migration-http-client";
import type { AgentMigrationServer } from "#src/agent-migration/transfer-ports";
import {
  agentMessage,
  agentReminder,
  reconcileAgentSend,
  type AgentMessagePorts,
} from "./agent-message-operations";
import {
  createAgentTaskIdleNudgeHttpClient,
  type AgentTaskIdleNudgeHttpClient,
} from "./agent-task-idle-nudge-client";
import {
  defaultAgentMessageHttpClient,
  defaultAgentWeeklyReportHttpClient,
  defaultAgentTaskHttpClient,
  defaultAgentChannelHttpClient,
  defaultAgentActionPrepareHttpClient,
  type AgentMessageHttpClient,
  type AgentTaskHttpClient,
  type AgentChannelHttpClient,
  type AgentActionPrepareHttpClient,
  type AgentWeeklyReportHttpClient,
  type AgentMessageTransportResponse,
  type AgentSendReconciliationRequest,
} from "./agent-http-clients";
import {
  RECONNECT_READY_RETRY_MS,
  RECONNECT_READY_RETRY_MAX_MS,
  READY_RETRY_ESCALATE_AFTER,
  CONNECT_RETRY_ESCALATE_AFTER,
  RESUME_CONNECT_MS,
  RESUME_CONNECT_MAX_MS,
  STABLE_CONNECTION_MS,
  escalates,
  readyFailureStage,
  type ConnectOutage,
} from "./connection-retry";
import { ComputerLifecyclePublications } from "./upgrade-result-send";
export { COMPUTER_STATUS_REFRESH_MS } from "./daemon-status-refresh";
import { DaemonStatusRefresh } from "./daemon-status-refresh";
const logger = getLogger(["coforge", "daemon", "connection"]);

export class DaemonConnection extends DaemonConnectionAgentHttp implements DaemonConnectionClient {
  #link: { readonly client: CentrifugeWorkspaceClient; open: boolean } | undefined;

  get #client(): CentrifugeWorkspaceClient | undefined {
    return this.#link?.client;
  }

  get #connected(): boolean {
    const link = this.#link;
    if (!link) return false;
    return link.client.state === undefined ? link.open : link.client.state === "connected";
  }

  #hasConnected = false;
  #token = "";
  #serverHttpUrl = "";
  #startConfig: DaemonConnectionConfig | undefined;
  readonly #rebuild = new LostClientRebuild(
    () => (this.#startConfig ? { token: this.#token, config: this.#startConfig } : undefined),
    (token, config) => this.start(token, config),
    (error) => error instanceof DaemonConnectionStoppedError,
    diagnosticErrorCode,
  );
  readonly #runtimeAuthIntent = new ListenerSlot<(intent: RuntimeAuthIntent) => void>();
  readonly #agentStart = new ListenerSlot<(intent: AgentStartIntent) => void>();
  readonly #agentStop = new ListenerSlot<(intent: AgentStopIntent) => void>();
  readonly #agentStaleRuntimeStop = new ListenerSlot<(intent: AgentStaleRuntimeStop) => void>();
  readonly #agentTurnInterrupt = new ListenerSlot<(intent: AgentTurnInterruptIntent) => void>();
  readonly #agentActivityProbe = new ListenerSlot<(probe: AgentActivityProbe) => void>();
  readonly #agentInboxPurge = new ListenerSlot<(purge: AgentInboxPurge) => void>();
  readonly #agentWorkspaceReset = new ListenerSlot<(request: AgentWorkspaceResetRequest) => void>();
  readonly #agentMessage = new ListenerSlot<(message: AgentMessageDelivery) => void>();
  readonly #serverPublications = new ServerPublications();
  readonly rejectedControl = new RejectedControl();
  readonly #appRegistrationNotice = new ListenerSlot<(notice: AppRegistrationNotice) => void>();
  readonly #agentMigrationLease = new ListenerSlot<(lease: ReceivedAgentMigrationLease) => void>();
  readonly #agentMigrationCancel = new ListenerSlot<(cancel: AgentMigrationCancel) => void>();
  readonly #queries = new DaemonQueries((method, bytes) => this.#rpc(method, bytes));
  protected get daemonQueries() {
    return this.#queries;
  }

  /** What the forwarded Agent requests read: this connection's origin, keys and route clients,
   * built on the first request once the fields it reads exist. */
  #agentHttpDeps: AgentHttpDeps | undefined;
  protected get agentHttp(): AgentHttpDeps {
    return (this.#agentHttpDeps ??= {
      serverHttpUrl: () => this.#serverHttpUrl,
      token: () => this.#token,
      assertServerHttp: () => this.#assertServerHttp(),
      keys: (agentApiKey) => this.#agentKeys(agentApiKey),
      clients: {
        message: this.agentMessageHttpClient,
        task: this.agentTaskHttpClient,
        channel: this.agentChannelHttpClient,
        actionPrepare: this.agentActionPrepareHttpClient,
        weeklyReport: this.agentWeeklyReportHttpClient,
        taskIdleNudge: this.agentTaskIdleNudgeHttpClient,
      },
    });
  }
  readonly #providerPublications = new DaemonProviderPublications((method, bytes) =>
    this.#rpc(method, bytes),
  );
  readonly #notices = new DaemonNoticePublications((method, bytes) => this.#rpc(method, bytes));
  readonly #reconnect = new ListenerSlot<() => void>();
  readonly #inboundQuiet = new InboundQuietness(() => this.#nowMs());
  readonly #latestComputerVersion = new ListenerSlot<(version: string) => void>();
  #agentControlAccepted = false;
  readonly #connectionRefused = new ListenerSlot<(reason: DaemonConnectRejectionReason) => void>();
  #failPendingStart: ((error: Error) => void) | undefined;
  #outage: ConnectOutage | undefined;
  #stableSinceMs: number | undefined;
  #connectFailure: string | undefined;
  #readyFailure: string | undefined;
  #resumeTimer: unknown;
  #readyPublications = new ReadyPublicationHold();
  #upgradeReadyReceipt?: (receipt: string) => void;
  #readyRequestFactory: (() => DaemonRuntimeReadyRequest) | undefined;
  #readyRecoveryClient: CentrifugeWorkspaceClient | undefined;
  #readyRetryTimer: unknown;
  #readyRetryAttempts = 0;
  #firstReady: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  #readyFailingSinceMs: number | undefined;
  readonly #pendingActivity = new Map<string, AgentActivity>();
  readonly #supersededActivityLaunches = new Map<string, Set<string>>();
  readonly #pendingSessionInvalidate = new Map<string, AgentSessionInvalidate>();
  readonly #latestObservedLaunchByAgent = new Map<string, string>();
  #loggedUnknownSessionInvalidateMethod = false;
  readonly #observations = new AgentObservationPublisher(undefined, {
    timing: {
      schedule: (callback, delayMs) => this.timing.schedule(callback, delayMs),
      cancel: (timer) => this.timing.cancel(timer),
    },
  });
  readonly #latestStatuses = new Map<string, AgentStatus>();
  readonly #computerLifecycle = new ComputerLifecyclePublications((method, bytes) =>
    this.#rpc(method, bytes),
  );
  readonly #statusRefresh = new DaemonStatusRefresh({
    client: () => this.#client,
    connected: () => this.#connected,
    reconnect: () => this.#rebuild.attempt(),
    statuses: () => this.#latestStatuses.values(),
    queueStatus: (client, status) => this.#queueAgentStatus(client, status),
    inboundQuiet: this.#inboundQuiet,
    latestComputerVersion: this.#latestComputerVersion,
    timing: () => this.timing,
  });
  #statusRpcQueue = Promise.resolve();
  constructor(
    private readonly endpoint: string,
    private readonly clientFactory: CentrifugeWorkspaceClientFactory = defaultCentrifugeWorkspaceClientFactory,
    private readonly agentMessageHttpClient: AgentMessageHttpClient = defaultAgentMessageHttpClient,
    private readonly timing: DaemonConnectionTiming = defaultDaemonConnectionTiming,
    private readonly agentTaskHttpClient: AgentTaskHttpClient = defaultAgentTaskHttpClient,
    private readonly agentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = defaultAgentWeeklyReportHttpClient,
    private readonly agentChannelHttpClient: AgentChannelHttpClient = defaultAgentChannelHttpClient,
    private readonly agentActionPrepareHttpClient: AgentActionPrepareHttpClient = defaultAgentActionPrepareHttpClient,
    private readonly agentTaskIdleNudgeHttpClient: AgentTaskIdleNudgeHttpClient = createAgentTaskIdleNudgeHttpClient(
      AGENT_RPC_TIMEOUT_MS,
    ),
  ) {
    super();
    if (!endpoint) throw new Error("cloud endpoint not configured");
  }
  async start(_token: string, config: DaemonConnectionConfig): Promise<void> {
    this.#token = _token;
    this.#serverHttpUrl = config.serverHttpUrl ?? "";
    this.#startConfig = config;
    if (this.#connected) return;
    const client = this.clientFactory(
      this.endpoint,
      daemonConnectHeaders(_token, config.workerInstanceId),
    );
    this.#link = { client, open: false };
    const daemonChannel = `daemon:${config.workspaceId}:${config.computerId}`;
    const scope = { workspace_id: config.workspaceId, computer_id: config.computerId };
    client.on("publication", ({ channel, data }) => {
      if (client !== this.#client || channel !== daemonChannel) return;
      this.#inboundQuiet.markInbound();
      this.#handleAgentPublication(data, config);
    });
    client.on("disconnected", (context) => {
      const link = this.#link;
      if (link?.client !== client) return;
      link.open = false;
      this.#observations.resetConnectionLifetime();
      this.#cancelReadyRecovery();
      const refusal = context ? daemonConnectRejectionReason(context) : undefined;
      if (!refusal) {
        if (context?.code !== disconnectedCodes.disconnectCalled)
          this.#resumeAfterGiveUp(client, scope, context);
        return;
      }
      logger.error("The cloud refused this Workspace connection for good", {
        event: "daemon_connection:refused",
        ...scope,
        reason: refusal,
        outcome: "refused",
      });
      if (this.#failPendingStart) this.#failPendingStart(new DaemonConnectionRefusedError(refusal));
      else this.#connectionRefused.current?.(refusal);
    });
    const { signal } = config;
    let onAbort: (() => void) | undefined;
    await new Promise<void>((resolve, reject) => {
      this.#failPendingStart = reject;
      client.on("connected", () => {
        const link = this.#link;
        if (link?.client !== client) return;
        this.#failPendingStart = undefined;
        this.#endOutageIfStable(this.#nowMs());
        this.#connectFailure = undefined;
        const reconnect = this.#hasConnected;
        link.open = true;
        this.#hasConnected = true;
        this.#inboundQuiet.markInbound();
        logger.info("Daemon cloud connection established", {
          event: "daemon_connection:connected",
          ...scope,
          control_stream_binding: "connect_proxy",
          outcome: "ok",
        });
        reportDaemonOnline(client, config);
        this.#flushPendingSessionInvalidate(client);
        this.#flushPendingActivity(client);
        this.#observations.flush(client);
        for (const status of this.#latestStatuses.values()) this.#queueAgentStatus(client, status);
        this.#statusRefresh.start(config);
        if (reconnect && this.#readyRequestFactory) {
          this.#readyPublications.hold();
          this.#startReadyRecovery(client, this.#readyRequestFactory);
        }
        resolve();
      });
      if (signal?.aborted) return reject(signal.reason);
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      client.on("error", ({ type, error }) => {
        if (client !== this.#client) return;
        const details = { ...scope, error_type: type, error_code: diagnosticErrorCode(error) };
        if (type === "connect" || type === "transport")
          this.#recordConnectFailure(`${type} error ${error.code}: ${error.message}`, {
            ...details,
            retry_by: "client",
          });
        else
          logger.warning("Daemon cloud connection client reported an error", {
            event: "daemon_connection:client_error",
            ...details,
          });
      });
      client.connect();
    })
      .catch((error) => {
        this.#failPendingStart = undefined;
        this.#cancelReadyRecovery();
        this.#cancelResume();
        if (this.#link?.client === client) this.#link = undefined;
        client.disconnect();
        throw error;
      })
      .finally(() => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      });
  }
  #endOutageIfStable(now: number): void {
    if (this.#stableSinceMs !== undefined && now - this.#stableSinceMs >= STABLE_CONNECTION_MS)
      this.#outage = undefined;
    this.#stableSinceMs = undefined;
  }
  #recordConnectFailure(failure: string, details: Record<string, unknown>): ConnectOutage {
    const now = this.#nowMs();
    this.#endOutageIfStable(now);
    this.#connectFailure = failure;
    this.#readyFailure = undefined;
    const outage = (this.#outage ??= { failures: 0, sinceMs: now, resumes: 0 });
    outage.failures += 1;
    const properties = {
      event: "daemon_connection:retry_scheduled",
      ...details,
      attempt: outage.failures,
      failing_for_ms: now - outage.sinceMs,
    };
    if (escalates(outage.failures, CONNECT_RETRY_ESCALATE_AFTER))
      logger.error(
        "Daemon cloud connection keeps failing: this Computer is offline, so its Agents cannot be reached",
        properties,
      );
    else logger.warning("Daemon cloud connection attempt failed; retrying", properties);
    return outage;
  }
  #resumeAfterGiveUp(
    client: CentrifugeWorkspaceClient,
    scope: Record<string, unknown>,
    disconnect:
      | {
          code: number;
          reason: string;
        }
      | undefined,
  ): void {
    this.#endOutageIfStable(this.#nowMs());
    const resumes = this.#outage?.resumes ?? 0;
    const delayMs = Math.min(RESUME_CONNECT_MAX_MS, RESUME_CONNECT_MS * 2 ** resumes);
    const failure = disconnect
      ? `disconnected ${disconnect.code}: ${disconnect.reason}`
      : "disconnected";
    const outage = this.#recordConnectFailure(failure, {
      ...scope,
      ...(disconnect ? { disconnect_code: disconnect.code } : {}),
      retry_by: "daemon",
      retry_delay_ms: delayMs,
    });
    outage.resumes = resumes + 1;
    this.#resumeTimer = this.timing.schedule(() => {
      this.#resumeTimer = undefined;
      if (client === this.#client) client.connect();
    }, delayMs);
  }
  connectFailure(): string | undefined {
    return this.#readyFailure ?? this.#connectFailure;
  }
  #cancelResume(): void {
    if (this.#resumeTimer !== undefined) this.timing.cancel(this.#resumeTimer);
    this.#resumeTimer = undefined;
  }
  onAgentStart(callback: (intent: AgentStartIntent) => void): () => void {
    return this.#agentStart.set(callback);
  }
  onAgentStop(callback: (intent: AgentStopIntent) => void): () => void {
    return this.#agentStop.set(callback);
  }
  onAgentStaleRuntimeStop(callback: (intent: AgentStaleRuntimeStop) => void): () => void {
    return this.#agentStaleRuntimeStop.set(callback);
  }
  onAgentTurnInterrupt(callback: (intent: AgentTurnInterruptIntent) => void): () => void {
    return this.#agentTurnInterrupt.set(callback);
  }
  onAgentActivityProbe(callback: (probe: AgentActivityProbe) => void): () => void {
    return this.#agentActivityProbe.set(callback);
  }
  onAgentInboxPurge(callback: (purge: AgentInboxPurge) => void): () => void {
    return this.#agentInboxPurge.set(callback);
  }
  onAgentMessage(callback: (message: AgentMessageDelivery) => void): () => void {
    return this.#agentMessage.set(callback);
  }
  onAgentWorkspaceReset(callback: (request: AgentWorkspaceResetRequest) => void): () => void {
    return this.#agentWorkspaceReset.set(callback);
  }
  onRuntimeAuth(callback: (intent: RuntimeAuthIntent) => void): () => void {
    return this.#runtimeAuthIntent.set(callback);
  }
  onReminderDue(callback: (due: ReminderDue) => void): () => void {
    return this.#serverPublications.onReminderDue(callback);
  }
  onAppConfigSync(callback: (sync: AppConfigSync) => void): () => void {
    return this.#serverPublications.onAppConfigSync(callback);
  }
  onAgentServerFeatures(callback: (features: AgentServerFeatures) => void): () => void {
    return this.#serverPublications.onAgentServerFeatures(callback);
  }
  onAgentConfigSync(callback: (sync: AgentConfigSync) => void): () => void {
    return this.#serverPublications.onAgentConfigSync(callback);
  }
  onAppRegistrationNotice(callback: (notice: AppRegistrationNotice) => void): () => void {
    return this.#appRegistrationNotice.set(callback);
  }
  onAgentMigrationLease(callback: (lease: ReceivedAgentMigrationLease) => void): () => void {
    return this.#agentMigrationLease.set(callback);
  }
  onAgentMigrationCancel(callback: (cancel: AgentMigrationCancel) => void): () => void {
    return this.#agentMigrationCancel.set(callback);
  }
  onUsageScan(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void {
    return this.#providerPublications.onUsageScan(callback);
  }
  onResetCreditConsume(
    callback: (request: DaemonRuntimeResetCreditConsumeRequest) => Promise<void>,
  ): () => void {
    return this.#providerPublications.onResetCreditConsume(callback);
  }
  onProviderModelRefresh(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void {
    return this.#providerPublications.onProviderModelRefresh(callback);
  }
  onCommandCodeEffortRead(
    callback: (request: DaemonRuntimeCommandCodeEffortReadRequest) => Promise<void>,
  ): () => void {
    return this.#providerPublications.onCommandCodeEffortRead(callback);
  }
  onReconnect(callback: () => void): () => void {
    return this.#reconnect.set(callback);
  }
  onLatestComputerVersion(callback: (version: string) => void): () => void {
    return this.#latestComputerVersion.set(callback);
  }
  onConnectionRefused(callback: (reason: DaemonConnectRejectionReason) => void): () => void {
    return this.#connectionRefused.set(callback);
  }
  sendAgentActivity(activity: AgentActivity): void {
    const pending = this.#pendingActivity.get(activity.agentId);
    if (this.#supersededActivityLaunches.get(activity.agentId)?.has(activity.launchId)) return;
    if (pending?.launchId === activity.launchId && pending.clientSeq >= activity.clientSeq) return;
    if (pending && pending.launchId !== activity.launchId) {
      const superseded =
        this.#supersededActivityLaunches.get(activity.agentId) ?? new Set<string>();
      superseded.add(pending.launchId);
      this.#supersededActivityLaunches.set(activity.agentId, superseded);
    }
    if (!this.#connected || !this.#client?.publish) {
      this.#pendingActivity.set(activity.agentId, activity);
      return;
    }
    publishAgentActivity(this.#client, activity.workspaceId, encodeAgentActivity(activity));
  }
  sendAgentReplyIntent(frame: AgentReplyIntent): void {
    const client = this.#activeClient();
    if (client) publishAgentActivity(client, frame.workspaceId, encodeAgentReplyIntent(frame));
  }
  sendSessionInvalidate(message: AgentSessionInvalidate): void {
    if (this.#supersededActivityLaunches.get(message.agentId)?.has(message.launchId)) return;
    if (!this.#connected || !this.#client) {
      const observed = this.#latestObservedLaunchByAgent.get(message.agentId);
      if (observed !== undefined && observed !== message.launchId) return;
      this.#pendingSessionInvalidate.set(message.agentId, message);
      return;
    }
    this.#publishSessionInvalidate(this.#client, message);
  }
  sendAgentContextUsage(message: AgentContextUsage): void {
    this.#observations.sendContextUsage(message, this.#activeClient());
  }
  sendAgentTokenUsage(message: AgentTokenUsage): void {
    this.#observations.sendTokenUsage(message, this.#activeClient());
  }
  flushTokenUsage(timeoutMs = DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS): Promise<void> {
    return this.#observations.drainAdditive(this.#activeClient(), timeoutMs);
  }
  sendAgentServiceTier(message: AgentServiceTier): void {
    this.#observations.sendServiceTier(message, this.#activeClient());
  }
  sendAgentContextViewAvailability(message: AgentContextViewAvailability): void {
    this.#observations.sendContextViewAvailability(message, this.#activeClient());
  }
  async postAgentContextViewResult(result: AgentContextViewResult, agentApiKey?: string) {
    return postAgentContextViewResult(this.#serverHttpUrl, this.#token, result, agentApiKey);
  }
  #activeClient(): CentrifugeWorkspaceClient | undefined {
    return this.#connected ? this.#client : undefined;
  }
  sendAgentStatus(status: AgentStatus): void {
    this.#latestStatuses.set(status.agentId, status);
    if (this.#connected && this.#client) this.#queueAgentStatus(this.#client, status);
  }
  #observeLaunchIdentity(agentId: string, launchId: string): void {
    this.#latestObservedLaunchByAgent.set(agentId, launchId);
    const pending = this.#pendingSessionInvalidate.get(agentId);
    if (pending && pending.launchId !== launchId) this.#pendingSessionInvalidate.delete(agentId);
  }
  #flushPendingActivity(client: CentrifugeWorkspaceClient): void {
    if (!client.publish) return;
    const pending = [...this.#pendingActivity.values()];
    this.#pendingActivity.clear();
    this.#supersededActivityLaunches.clear();
    for (const activity of pending)
      publishAgentActivity(client, activity.workspaceId, encodeAgentActivity(activity));
  }
  #publishSessionInvalidate(
    client: CentrifugeWorkspaceClient,
    message: AgentSessionInvalidate,
  ): void {
    void client
      .rpc(AGENT_SESSION_INVALIDATE_METHOD, encodeAgentSessionInvalidate(message))
      .catch((error) => {
        const errorCode = diagnosticErrorCode(error);
        const unknownMethod = errorCode === "404";
        if (unknownMethod && this.#loggedUnknownSessionInvalidateMethod) return;
        if (unknownMethod) this.#loggedUnknownSessionInvalidateMethod = true;
        logger.warning("Agent session invalidate was not accepted", {
          event: "agent_session:invalidate_rejected",
          request_id: message.requestId,
          workspace_id: message.workspaceId,
          computer_id: message.computerId,
          agent_id: message.agentId,
          launch_id: message.launchId,
          reason: message.reason,
          error_code: errorCode,
          outcome: "failed",
        });
      });
  }
  #flushPendingSessionInvalidate(client: CentrifugeWorkspaceClient): void {
    const pending = [...this.#pendingSessionInvalidate.values()];
    this.#pendingSessionInvalidate.clear();
    for (const message of pending) {
      if (this.#supersededActivityLaunches.get(message.agentId)?.has(message.launchId)) continue;
      this.#publishSessionInvalidate(client, message);
    }
  }
  #queueAgentStatus(client: CentrifugeWorkspaceClient, status: AgentStatus): void {
    this.#statusRpcQueue = this.#statusRpcQueue
      .then(async () => {
        if (!this.#connected || client !== this.#client) return;
        await client.rpc(AGENT_STATUS_METHOD, encodeAgentStatus(status));
      })
      .catch(() => {});
  }
  #nowMs(): number {
    return this.timing.now ? this.timing.now() : Date.now();
  }

  /** Refuses an Agent request this connection has nowhere to send. Every path that asks checks the
   * server's HTTPS origin alone: these calls go to the cloud with the Agent's own key, and the
   * socket's state says nothing about whether the server answers (2026-11-16). */
  #assertServerHttp(): void {
    if (!this.#serverHttpUrl) throw new Error("daemon connection HTTP endpoint is not configured");
  }
  #requireClient(): CentrifugeWorkspaceClient {
    const client = this.#connected ? this.#link?.client : undefined;
    if (!client) throw new Error("daemon connection is not connected");
    return client;
  }
  #rpc(method: string, data: Uint8Array): Promise<unknown> {
    return this.#requireClient().rpc(method, data);
  }
  sendAgentDeliveryAck(ack: AgentMessageDeliveryAck): Promise<void> {
    return this.#notices.sendDeliveryAck(ack);
  }
  sendAgentDeliveryRejection(rejection: AgentMessageDeliveryRejection): Promise<void> {
    return this.#notices.sendDeliveryRejection(rejection);
  }
  sendAgentMentionDeliveryTransition(report: AgentMentionDeliveryTransition): Promise<void> {
    return this.#notices.sendMentionDeliveryTransition(report);
  }
  sendAgentMentionDeliveryTerminalError(report: AgentMentionDeliveryTerminalError): Promise<void> {
    return this.#notices.sendMentionDeliveryTerminalError(report);
  }
  sendAgentCredentialRestored(report: AgentCredentialRestored): Promise<void> {
    return this.#notices.sendCredentialRestored(report);
  }
  agentMigrationServer(): AgentMigrationServer {
    return new AgentMigrationHttpClient({
      endpoint: () =>
        serverEndpoint(this.#serverHttpUrl, "Agent migration", "/api/daemon/agent-migrations"),
      daemonApiKey: () => this.#token,
    });
  }
  #agentKeys(agentApiKey: string) {
    return { agentApiKey, daemonApiKey: this.#token };
  }
  async agentMessage(
    request: AgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageTransportResponse> {
    return agentMessage(this.#agentMessagePorts(), request, agentApiKey);
  }
  async reconcileAgentSend(
    request: AgentSendReconciliationRequest,
    agentApiKey: string,
  ): Promise<AgentSendReconciliationResponse> {
    return reconcileAgentSend(this.#agentMessagePorts(), request, agentApiKey);
  }
  #agentMessagePorts(): AgentMessagePorts {
    return {
      assertConnected: () => this.#assertServerHttp(),
      serverHttpUrl: this.#serverHttpUrl,
      keys: (agentApiKey) => this.#agentKeys(agentApiKey),
      client: this.agentMessageHttpClient,
    };
  }
  async workspaceInfo(
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse> {
    if (!this.#serverHttpUrl)
      throw new Error("Agent workspace_info HTTP endpoint is not configured");
    if (!this.agentMessageHttpClient.requestWorkspaceInfo)
      throw new Error("Agent workspace_info HTTP client is unavailable");
    return this.agentMessageHttpClient.requestWorkspaceInfo({
      url: serverEndpoint(
        this.#serverHttpUrl,
        "Agent workspace_info",
        agentApiRoutes.cloud.workspace.info.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentReminder(request: AgentReminderOperationRequest, agentApiKey: string) {
    return agentReminder(this.#agentMessagePorts(), request, agentApiKey);
  }
  async acknowledgeReminderDue(request: ReminderDueAckRequest): Promise<boolean> {
    const reply = await this.#rpc(REMINDER_DUE_ACK_METHOD, encodeReminderDueAckRequest(request));
    return decodeReminderDueAckResponse(rpcData(reply)).accepted;
  }
  async requestAppConfigSnapshot(request: AppConfigSnapshotRequest): Promise<AppConfigSync> {
    const reply = await this.#rpc(
      APP_CONFIG_SNAPSHOT_METHOD,
      encodeAppConfigSnapshotRequest(request),
    );
    return decodeAppConfigSync(rpcData(reply));
  }

  #handleAgentPublication(data: Uint8Array, config: DaemonConnectionConfig): void {
    const { workspaceId, computerId } = config;
    const ownsDaemon = (value: { workspaceId: string; computerId?: string }) =>
      value.workspaceId === workspaceId && value.computerId === computerId;
    const handled =
      routeRuntimeAuthPublication(data, config, this.#runtimeAuthIntent.current) ||
      this.#queries.receive(data, config) ||
      routePublication(
        data,
        decodeReminderSync,
        (sync) => sync.messageType === REMINDER_SYNC_MESSAGE_TYPE && ownsDaemon(sync),
      ) ||
      this.#serverPublications.route(
        data,
        { workspaceId, computerId: config.computerId },
        this.#readyPublications,
      ) ||
      routePublication(data, decodeAppRegistrationNotice, (notice) => {
        if (!ownsDaemon(notice)) return false;
        this.#readyPublications.deliver(this.#appRegistrationNotice, notice);
        return true;
      }) ||
      routePublication(data, decodeAgentMigrationLease, (lease) => {
        if (!ownsDaemon(lease)) return false;
        this.#readyPublications.deliver(this.#agentMigrationLease, {
          ...lease,
          deadline: Date.now() + lease.expiresInMs,
        });
        return true;
      }) ||
      routePublication(data, decodeAgentMigrationCancel, (cancel) => {
        if (!ownsDaemon(cancel)) return false;
        this.#readyPublications.deliver(this.#agentMigrationCancel, cancel);
        return true;
      }) ||
      this.#computerLifecycle.route(data, config, ownsDaemon) ||
      routePublication(data, decodeAgentWorkspaceResetRequest, (request) => {
        if (request.workspaceId === workspaceId)
          this.#readyPublications.deliver(this.#agentWorkspaceReset, request);
        return true;
      }) ||
      this.#providerPublications.route(data, workspaceId) ||
      routePublication(data, decodeAgentActivityProbe, (probe) => {
        if (probe.protocolMajor !== 1 || !ownsDaemon(probe)) return false;
        this.#readyPublications.deliver(this.#agentActivityProbe, probe, "probe");
        return true;
      }) ||
      routePublication(data, decodeAgentInboxPurge, (purge) => {
        if (purge.protocolMajor !== 1 || !ownsDaemon(purge)) return false;
        this.#readyPublications.deliver(this.#agentInboxPurge, purge);
        return true;
      });
    if (handled) return;
    const decoders = [
      {
        kind: "agent_message",
        decode: () =>
          this.#readyPublications.deliver(
            this.#agentMessage,
            ownedIntent(decodeAgentMessageDelivery(data), workspaceId),
            "notice",
          ),
      },
      {
        kind: "agent_stop",
        decode: () => {
          const intent = ownedIntent(decodeAgentStopIntent(data), workspaceId);
          this.#readyPublications.deliver(this.#agentStop, intent, "stop");
        },
      },
      {
        kind: "agent_turn_interrupt",
        decode: () => {
          const intent = ownedIntent(decodeAgentTurnInterruptIntent(data), workspaceId);
          if (!this.#readyPublications.holding)
            this.#readyPublications.deliver(this.#agentTurnInterrupt, intent);
        },
      },
      {
        kind: "agent_start",
        decode: () => {
          const intent = ownedIntent(decodeAgentStartIntent(data), workspaceId);
          this.#readyPublications.deliver(this.#agentStart, intent, "start");
        },
      },
    ];
    this.rejectedControl.decodeFirst(decoders, data, { workspaceId, computerId });
  }
  async sendAgentControlResult(result: AgentControlResult) {
    await this.#rpc(AGENT_CONTROL_RESULT_METHOD, encodeAgentControlResult(result));
  }
  agentControlAccepted(): boolean {
    return this.#agentControlAccepted;
  }
  async sendAgentTurnInterruptResult(result: AgentTurnInterruptResult) {
    await this.#rpc(AGENT_TURN_INTERRUPT_RESULT_METHOD, encodeAgentTurnInterruptResult(result));
  }
  async sendUpgradeResult(result: ComputerUpgradeResult): Promise<boolean> {
    return this.#computerLifecycle.sendUpgradeResult(result);
  }
  async sendShutdownNotice(notice: DaemonRuntimeShutdown): Promise<void> {
    return sendShutdownNoticeOver(this.#connected ? this.#client : undefined, this.timing, notice);
  }
  sendUsageScanResult(response: DaemonRuntimeUsageScanResponse): Promise<void> {
    return this.#providerPublications.sendUsageScanResult(response).then(() => undefined);
  }
  sendResetCreditConsumeResult(response: DaemonRuntimeResetCreditConsumeResponse): Promise<void> {
    return this.#providerPublications.sendResetCreditConsumeResult(response).then(() => undefined);
  }
  sendProviderModelRefreshResult(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<void> {
    return this.#providerPublications
      .sendProviderModelRefreshResult(response)
      .then(() => undefined);
  }
  sendCommandCodeEffortReadResult(
    response: DaemonRuntimeCommandCodeEffortReadResponse,
  ): Promise<void> {
    return this.#providerPublications
      .sendCommandCodeEffortReadResult(response)
      .then(() => undefined);
  }
  async ready(
    createRequest: () => DaemonRuntimeReadyRequest,
    signal?: AbortSignal,
    onUpgradeReadyReceipt?: (receipt: string) => void,
  ): Promise<void> {
    const client = this.#requireClient();
    signal?.throwIfAborted();
    this.#readyPublications.hold();
    this.#readyRequestFactory = createRequest;
    this.#upgradeReadyReceipt = onUpgradeReadyReceipt;
    const firstReady = Promise.withResolvers<void>();
    this.#firstReady = firstReady;
    const onAbort = () => this.#failFirstReady(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    this.#startReadyRecovery(client, createRequest);
    try {
      await firstReady.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
  #failFirstReady(error: unknown): void {
    if (!this.#firstReady) return;
    this.#cancelReadyRecovery();
    const firstReady = this.#firstReady;
    this.#firstReady = undefined;
    firstReady?.reject(error);
  }
  updateCodeAgents(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void> {
    return sendCodeAgentsUpdate((m, d) => this.#rpc(m, d), request);
  }
  reportRuntimeAuthLogin(report: RuntimeAuthLoginReport): Promise<void> {
    return sendRuntimeAuthLogin((m, d) => this.#rpc(m, d), report);
  }
  reportRuntimeAuthLogout(report: RuntimeAuthLogoutReport): Promise<void> {
    return sendRuntimeAuthLogout((m, d) => this.#rpc(m, d), report);
  }
  reportRuntimeAuthStatus(report: RuntimeAuthStatusReport): Promise<void> {
    return sendRuntimeAuthStatus((m, d) => this.#rpc(m, d), report);
  }
  sendMachineDiskStatus(report: MachineStatusReport): Promise<void> {
    return this.#notices.sendMachineDiskStatus(report);
  }
  sendMachineMemoryStatus(report: MachineStatusReport): Promise<void> {
    return this.#notices.sendMachineMemoryStatus(report);
  }
  async reportAgentSession(report: AgentSessionReport): Promise<void> {
    await reportAgentSessionWithRetry(
      {
        observeLaunch: (agentId, launchId) => this.#observeLaunchIdentity(agentId, launchId),
        rpc: async (method, data) => {
          await this.#requireClient().rpc(method, data);
        },
      },
      report,
    );
  }
  #startReadyRecovery(
    client: CentrifugeWorkspaceClient,
    createRequest: () => DaemonRuntimeReadyRequest,
  ): void {
    if (this.#readyRecoveryClient === client) return;
    this.#cancelReadyRecovery();
    this.#readyRecoveryClient = client;
    void this.#attemptReadyRecovery(client, createRequest);
  }
  async #attemptReadyRecovery(
    client: CentrifugeWorkspaceClient,
    createRequest: () => DaemonRuntimeReadyRequest,
  ): Promise<void> {
    const recovering = () =>
      client === this.#client && client === this.#readyRecoveryClient && this.#connected;
    if (!recovering()) return;
    const request = createRequest();
    const scope = {
      request_id: request.requestId,
      workspace_id: request.workspaceId,
      computer_id: request.computerId,
    };
    try {
      await sendDaemonReady(
        client,
        request,
        (version) => this.#latestComputerVersion.current?.(version),
        (accepted) => {
          this.#agentControlAccepted = accepted;
        },
        (receipt) => {
          if (recovering()) this.#upgradeReadyReceipt?.(receipt);
        },
      );
    } catch (error) {
      if (!recovering()) return;
      const delayMs = Math.min(
        RECONNECT_READY_RETRY_MAX_MS,
        RECONNECT_READY_RETRY_MS * 2 ** this.#readyRetryAttempts,
      );
      this.#readyRetryAttempts += 1;
      this.#readyFailingSinceMs ??= Date.now();
      const stage = readyFailureStage(error);
      this.#readyFailure = `ready failed: ${stage ?? diagnosticErrorCode(error)}`;
      const details = {
        event: "daemon_ready:retry_scheduled",
        ...scope,
        error_code: diagnosticErrorCode(error),
        ...(stage ? { server_stage: stage } : {}),
        retry_delay_ms: delayMs,
        attempt: this.#readyRetryAttempts,
        failing_for_ms: Date.now() - this.#readyFailingSinceMs,
      };
      if (escalates(this.#readyRetryAttempts, READY_RETRY_ESCALATE_AFTER))
        logger.error(
          "Daemon ready keeps failing: this Computer is connected but its Workspace is not recovered, so its Agents cannot be reached",
          details,
        );
      else logger.warning("Daemon ready failed; retrying", details);
      this.#readyRetryTimer = this.timing.schedule(() => {
        this.#readyRetryTimer = undefined;
        void this.#attemptReadyRecovery(client, createRequest);
      }, delayMs);
      return;
    }
    if (!recovering()) return;
    if (this.#readyFailingSinceMs !== undefined)
      logger.info("Daemon reconnect recovery succeeded after failing", {
        event: "daemon_ready:recovered",
        ...scope,
        attempts: this.#readyRetryAttempts,
        failed_for_ms: Date.now() - this.#readyFailingSinceMs,
      });
    this.#readyFailingSinceMs = undefined;
    this.#readyRetryAttempts = 0;
    this.#readyFailure = undefined;
    this.#stableSinceMs = this.#nowMs();
    this.#readyRecoveryClient = undefined;
    this.#readyPublications.dispatch();
    const firstReady = this.#firstReady;
    if (!firstReady) {
      this.#reconnect.current?.();
      return;
    }
    this.#firstReady = undefined;
    logger.info("Daemon ready completed", {
      event: "daemon_ready:completed",
      ...scope,
      running_agent_count: request.runningAgentIds.length,
      outcome: "ok",
    });
    firstReady.resolve();
  }
  #cancelReadyRecovery(): void {
    if (this.#readyRetryTimer !== undefined) this.timing.cancel(this.#readyRetryTimer);
    this.#readyRetryTimer = undefined;
    this.#readyRecoveryClient = undefined;
  }
  heldPublicationCount(): number {
    return this.#readyPublications.size();
  }
  async stop(): Promise<void> {
    const client = this.#client;
    this.#failPendingStart?.(new DaemonConnectionStoppedError());
    this.#failFirstReady(new DaemonConnectionStoppedError());
    this.#cancelReadyRecovery();
    this.#cancelResume();
    this.#outage = undefined;
    this.#stableSinceMs = undefined;
    this.#connectFailure = undefined;
    this.#readyFailure = undefined;
    this.#readyRetryAttempts = 0;
    this.#readyFailingSinceMs = undefined;
    this.#statusRefresh.stop();
    await this.#statusRpcQueue;
    this.#link = undefined;
    // Nothing to rebuild from: a stopped connection must not come back on its own.
    this.#startConfig = undefined;
    this.#rebuild.reset();
    this.#hasConnected = false;
    for (const slot of [
      this.#agentStart,
      this.#agentStop,
      this.#agentActivityProbe,
      this.#agentInboxPurge,
      this.#agentWorkspaceReset,
      this.#agentMessage,
      this.#serverPublications,
      this.#appRegistrationNotice,
      this.#agentMigrationLease,
      this.#agentMigrationCancel,
      this.#reconnect,
      this.#connectionRefused,
    ])
      slot.clear();
    this.#readyPublications.clear();
    this.#readyRequestFactory = undefined;
    this.#upgradeReadyReceipt = undefined;
    for (const collection of [
      this.#pendingActivity,
      this.#supersededActivityLaunches,
      this.#latestStatuses,
      this.#computerLifecycle,
      this.#latestObservedLaunchByAgent,
    ])
      collection.clear();
    this.#observations.clear();
    this.#loggedUnknownSessionInvalidateMethod = false;
    this.#observations.resetConnectionLifetime();
    this.#statusRpcQueue = Promise.resolve();
    client?.disconnect();
  }
}
