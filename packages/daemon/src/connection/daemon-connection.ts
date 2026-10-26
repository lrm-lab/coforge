import type {
  AgentLaunchConfig,
  DaemonConnectionConfig,
  DaemonConnectionClient,
  ReceivedAgentMigrationLease,
} from "./daemon-connection-client";
import {
  decodeRuntimeAuthIntent,
  encodeRuntimeAuthLoginReport,
  encodeRuntimeAuthLogoutReport,
  RUNTIME_AUTH_LOGIN_REPORT_METHOD,
  RUNTIME_AUTH_LOGOUT_REPORT_METHOD,
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

import {
  encodeAgentReplyIntent,
  type AgentReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";
import { ListenerSlot } from "./listener-slot";
import { rpcData } from "./rpc-data";
import { DaemonQueries } from "./daemon-queries";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  GitHubCredentialRequest,
  GitHubCommitTrailersRequest,
  AgentManualGetRequest,
  AgentManualSearchRequest,
  AgentUserInfoRequest,
  AgentProfileShowRequest,
  AgentProfileUpdateRequest,
  AgentAppConfigGetRequest,
  AgentAppRequest,
  AgentAppConfigUpdateRequest,
  AgentMentionExecuteRequest,
  AgentMentionPendingRequest,
  AgentAttachmentCommentsRequest,
  AgentInboxListResponse,
  AgentInboxRequest,
  AgentThreadListResponse,
  AgentMentionDeliveryRequest,
  AgentSendReconciliationResponse,
} from "@lrm/coforge-sdk/agent";
import {
  forwardOpenVikingControl,
  forwardOpenVikingRead,
  type OpenVikingAgentProxyCommand,
} from "../openviking-read-proxy";
import { DaemonConnectionRefusedError } from "./daemon-connection-refused-error";
import { DaemonConnectionStoppedError } from "./daemon-connection-stopped-error";
import { HELD_NOTICE_CAP, HeldPublications } from "./held-publications";
import { AgentObservationPublisher } from "./agent-observation-publisher";
import {
  daemonConnectRejectionReason,
  type DaemonConnectData,
  type DaemonConnectRejectionReason,
  decodeAgentWorkspaceResetRequest,
  encodeAgentControlResult,
  encodeAgentTurnInterruptResult,
  encodeAgentSessionReport,
  encodeAgentSessionInvalidate,
  AGENT_CONTROL_RESULT_METHOD,
  AGENT_TURN_INTERRUPT_RESULT_METHOD,
  AGENT_SESSION_METHOD,
  AGENT_SESSION_INVALIDATE_METHOD,
  AGENT_CONTEXT_USAGE_METHOD,
  AGENT_SERVICE_TIER_METHOD,
  type AgentWorkspaceResetRequest,
  type AgentControlResult,
  type AgentTurnInterruptResult,
  type AgentSessionReport,
  type AgentSessionInvalidate,
  type AgentContextUsage,
  type AgentServiceTier,
  decodeAgentStartIntent,
  decodeAgentStopIntent,
  decodeAgentTurnInterruptIntent,
  decodeAgentActivityProbe,
  decodeAgentInboxPurge,
  type ComputerUpgradeResult,
  decodeDaemonRuntimeUsageScanRequest,
  encodeDaemonRuntimeUsageScanResponse,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeAgentMessageDelivery,
  decodeComputerRestartIntent,
  decodeComputerUpgradeIntent,
  encodeComputerUpgradeResult,
  COMPUTER_UPGRADE_RESULT_METHOD,
  encodeAgentActivity,
  encodeAgentStatus,
  encodeAgentMessageDeliveryAck,
  encodeAgentMessageDeliveryRejection,
  encodeAgentMentionDeliveryTransition,
  encodeAgentMentionDeliveryTerminalError,
  AGENT_MENTION_DELIVERY_TRANSITION_METHOD,
  AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD,
  type AgentMentionDeliveryTransition,
  type AgentMentionDeliveryTerminalError,
  encodeDaemonRuntimeReadyRequest,
  encodeDaemonRuntimeCodeAgentsUpdateRequest,
  encodeRuntimeAuthStatusReport,
  RUNTIME_AUTH_STATUS_REPORT_METHOD,
  type RuntimeAuthStatusReport,
  DAEMON_RUNTIME_READY_METHOD,
  DAEMON_RUNTIME_SHUTDOWN_METHOD,
  encodeDaemonRuntimeShutdown,
  type DaemonRuntimeShutdown,
  DAEMON_CONNECTION_STATUS_METHOD,
  DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
  DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
  DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
  AGENT_MESSAGE_ACK_METHOD,
  AGENT_MESSAGE_REJECT_METHOD,
  AGENT_STATUS_METHOD,
  type DaemonRuntimeReadyRequest,
  type DaemonRuntimeCodeAgentsUpdateRequest,
  type DaemonRuntimeUsageScanRequest,
  type DaemonRuntimeUsageScanResponse,
  type DaemonRuntimeProviderModelRefreshRequest,
  type DaemonRuntimeProviderModelRefreshResponse,
  type AgentActivity,
  type AgentStatus,
  type AgentStartIntent,
  type AgentStopIntent,
  type AgentTurnInterruptIntent,
  type AgentActivityProbe,
  type AgentInboxPurge,
  type AgentMessageDelivery,
  type AgentMessageDeliveryAck,
  type AgentMessageDeliveryRejection,
  type AgentMessageRequest,
  type WorkspaceInfoRequest,
  type WorkspaceInfoResponse,
  REMINDER_FIRE_METHOD,
  REMINDER_SNAPSHOT_METHOD,
  REMINDER_SYNC_MESSAGE_TYPE,
  decodeReminderFireResponse,
  decodeReminderSync,
  decodeAgentMigrationCancel,
  decodeAgentMigrationLease,
  encodeReminderFireRequest,
  encodeReminderSnapshotRequest,
  type AgentReminderOperationRequest,
  type ReminderFireRequest,
  type ReminderFireResponse,
  type ReminderSnapshotRequest,
  type ReminderSync,
  APP_CONFIG_SNAPSHOT_METHOD,
  decodeAppConfigSync,
  encodeAppConfigSnapshotRequest,
  type AppConfigSnapshotRequest,
  type AppConfigSync,
  type AgentMigrationCancel,
  type TaskRequest,
  type TaskResponse,
  type WeeklyReportRequest,
  type WeeklyReportResponse,
  utf8Encoder,
  refusalText,
  thrownMessage,
} from "@lrm/coforge-sdk/internal";

import { parseAgentLaunchIdentity } from "./agent-launch-identity";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import {
  decodeAppRegistrationNotice,
  type AppRegistrationNotice,
} from "@lrm/coforge-sdk/internal/app-registration-notice";
import { agentAppCloudRequest } from "./agent-app-cloud-request";
import {
  parseAgentApiKey,
  parseAgentEnvironment,
  parseAgentRuntimeProviderConfig,
} from "./agent-launch-response";
import { controlPayloadShape } from "./control-payload";
import { connectionLiveness, INBOUND_STALLED_MS } from "./connection-liveness";
import { DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS } from "./shutdown-notice-timeout";
import { getLogger } from "@logtape/logtape";
import {
  AGENT_RPC_TIMEOUT_MS,
  agentHeaders,
  channelEndpointFor,
  sendAgentJson,
} from "./agent-http-wire";
import { AgentMigrationHttpClient } from "./agent-migration-http-client";
import type { AgentMigrationServer } from "#src/agent-migration/transfer-ports";
import { adaptAgentHistoryResponse } from "./agent-history-response";
import {
  adaptAgentReactionResponse,
  adaptAgentResolveResponse,
  adaptAgentSearchResponse,
  adaptAgentSendResponse,
} from "./agent-message-adapters";
import type { AgentHttpInput } from "./agent-http-wire";
import {
  defaultAgentMessageHttpClient,
  defaultAgentWeeklyReportHttpClient,
  defaultAgentWeeklyReportCollectHttpClient,
  defaultAgentWeeklyReportKeyPointsHttpClient,
  defaultAgentWeeklyReportMemoryHttpClient,
  defaultAgentTaskHttpClient,
  defaultAgentChannelHttpClient,
  defaultAgentActionPrepareHttpClient,
  type AgentMessageHttpClient,
  type AgentTaskHttpClient,
  type AgentChannelHttpClient,
  type AgentActionPrepareHttpClient,
  type AgentWeeklyReportHttpClient,
  type AgentChannelRequest,
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

const AGENT_STATUS_REFRESH_MS = 30_000;
export const COMPUTER_STATUS_REFRESH_MS = 30_000;
const REMEMBERED_REQUEST_IDS = 256;
const logger = getLogger(["coforge", "daemon", "connection"]);

export interface DaemonConnectionTiming {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
  scheduleRepeating?(callback: () => void, delayMs: number): unknown;
  cancelRepeating?(timer: unknown): void;
  /** The connection's own clock, so a test can cross the inbound-liveness window without
   * waiting for it. Production reads the wall clock. */
  now?(): number;
}

const defaultDaemonConnectionTiming: DaemonConnectionTiming = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  cancel(timer) {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

/** The Daemon's single connection for its configured Workspace. */
export class DaemonConnection implements DaemonConnectionClient {
  #client: CentrifugeWorkspaceClient | undefined;
  #connected = false;
  #hasConnected = false;
  #token = "";
  #serverHttpUrl = "";
  readonly #runtimeAuthIntent = new ListenerSlot<(intent: RuntimeAuthIntent) => void>();
  readonly #agentStart = new ListenerSlot<(intent: AgentStartIntent) => void>();
  readonly #agentStop = new ListenerSlot<(intent: AgentStopIntent) => void>();
  readonly #agentTurnInterrupt = new ListenerSlot<(intent: AgentTurnInterruptIntent) => void>();
  readonly #agentActivityProbe = new ListenerSlot<(probe: AgentActivityProbe) => void>();
  readonly #agentInboxPurge = new ListenerSlot<(purge: AgentInboxPurge) => void>();
  readonly #agentWorkspaceReset = new ListenerSlot<(request: AgentWorkspaceResetRequest) => void>();
  readonly #agentMessage = new ListenerSlot<(message: AgentMessageDelivery) => void>();
  readonly #reminderSync = new ListenerSlot<(sync: ReminderSync) => void>();
  readonly #appConfigSync = new ListenerSlot<(sync: AppConfigSync) => void>();
  readonly #appRegistrationNotice = new ListenerSlot<(notice: AppRegistrationNotice) => void>();
  readonly #agentMigrationLease = new ListenerSlot<(lease: ReceivedAgentMigrationLease) => void>();
  readonly #agentMigrationCancel = new ListenerSlot<(cancel: AgentMigrationCancel) => void>();
  readonly #queries = new DaemonQueries((method, bytes) => this.#rpc(method, bytes));
  readonly #usageScan = new ListenerSlot<
    (request: DaemonRuntimeUsageScanRequest) => Promise<void>
  >();
  readonly #providerModelRefresh = new ListenerSlot<
    (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>
  >();
  readonly #reconnect = new ListenerSlot<() => void>();
  readonly #connectionRefused = new ListenerSlot<(reason: DaemonConnectRejectionReason) => void>();
  /** Set only while `start` waits for the first connection; rejecting it ends that `start`. */
  #failPendingStart: ((error: Error) => void) | undefined;
  /** The current run of failed connect attempts, first connect included; cleared once the
   * connection is up. `resumes` counts only the daemon's own reconnects after a give-up. */
  #outage: ConnectOutage | undefined;
  /** When ready was last accepted on the current connection; see `STABLE_CONNECTION_MS`. */
  #stableSinceMs: number | undefined;
  /** Why the latest connect attempt failed, since the connection last came up. */
  #connectFailure: string | undefined;
  /** Why the latest ready failed, while it is being retried. */
  #readyFailure: string | undefined;
  /** Connects the client again after it gave up; see `#resumeAfterGiveUp`. */
  #resumeTimer: unknown;
  /** Publications received between a ready request and its acknowledgement, in arrival order. */
  #readyPublications: HeldPublications<() => void> | undefined;
  #readyRequestFactory: (() => DaemonRuntimeReadyRequest) | undefined;
  #readyRecoveryClient: CentrifugeWorkspaceClient | undefined;
  #readyRetryTimer: unknown;
  #readyRetryAttempts = 0;
  /** Settles the first `ready`; set only while it waits for the cloud to accept it. */
  #firstReady: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  /** When the current run of ready failures began, so a log line can say how long this machine has
   * been connected without a recovered Workspace. Cleared the moment ready succeeds. */
  #readyFailingSinceMs: number | undefined;
  readonly #pendingActivity = new Map<string, AgentActivity>();
  readonly #supersededActivityLaunches = new Map<string, Set<string>>();
  /** Latest-per-agent, like `#pendingActivity`. */
  readonly #pendingSessionInvalidate = new Map<string, AgentSessionInvalidate>();
  /** The latest launch a *non*-Activity, non-invalidate outbound message has reported for an
   * Agent (today, only `reportAgentSession` carries a `launchId`; `AgentStatus` does not).
   * Drives `sendSessionInvalidate`'s drop/refuse-to-queue rule below — deliberately not
   * Activity's own `#supersededActivityLaunches` bookkeeping, which stays exactly as it was for
   * Activity replay. */
  readonly #latestObservedLaunchByAgent = new Map<string, string>();
  /** True once an old server's "unknown RPC method" rejection of `agent:session:invalidate` has
   * been logged; suppresses repeats for the rest of this connection's lifetime (fix for a log
   * line that used to repeat on every rejected attempt). */
  #loggedUnknownSessionInvalidateMethod = false;
  /** Latest-per-agent per-launch observations (a context-window reading, the applied service
   * tier): buffered while disconnected, flushed on reconnect, never retried or surfaced. */
  readonly #observations = new AgentObservationPublisher({
    contextUsage: AGENT_CONTEXT_USAGE_METHOD,
    serviceTier: AGENT_SERVICE_TIER_METHOD,
  });
  readonly #latestStatuses = new Map<string, AgentStatus>();
  readonly #restartRequestIds = new Set<string>();
  readonly #upgradeRequestIds = new Set<string>();
  readonly #reportedUpgradeRequestIds = new Set<string>();
  #statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #computerStatusRefreshTimer: unknown;
  /** When this connection last carried inbound traffic, by the connection's own clock. Only a
   * publication on the Daemon's channel or an answered status RPC sets it; an open socket does
   * not, which is the whole point. Undefined until the connection first reports connected. */
  #lastInboundAtMs: number | undefined;
  /** Same log suppression as `#loggedUnknownSessionInvalidateMethod`, but per quiet stretch
   * rather than per connection: cleared the moment anything arrives. */
  #loggedInboundQuiet = false;
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
  ) {
    if (!endpoint) throw new Error("cloud endpoint not configured");
  }

  async start(_token: string, config: DaemonConnectionConfig): Promise<void> {
    this.#token = _token;
    this.#serverHttpUrl = config.serverHttpUrl ?? "";
    if (this.#connected) return;
    const connectData: DaemonConnectData = { daemonApiKey: _token };
    const client = this.clientFactory(
      this.endpoint,
      "",
      utf8Encoder.encode(JSON.stringify(connectData)),
    );
    this.#client = client;
    const daemonChannel = `daemon:${config.workspaceId}:${config.computerId}`;
    const scope = { workspace_id: config.workspaceId, computer_id: config.computerId };
    client.on("publication", ({ channel, data }) => {
      if (client !== this.#client || channel !== daemonChannel) return;
      // Before any decoding: a frame this Daemon cannot act on still proves the link carries
      // traffic, and the liveness window must not mistake an undecodable frame for silence.
      this.#markInbound();
      this.#handleAgentPublication(data, config);
    });
    // centrifuge-js emits `disconnected` only once it has stopped reconnecting; while it retries
    // it reports `connecting` instead.
    client.on("disconnected", (context) => {
      if (client !== this.#client) return;
      this.#connected = false;
      this.#cancelReadyRecovery();
      const refusal = context ? daemonConnectRejectionReason(context) : undefined;
      if (!refusal) {
        // A disconnect this connection asked for is followed by whatever connect it wanted.
        if (context?.code !== disconnectedCodes.disconnectCalled)
          this.#resumeAfterGiveUp(client, scope, context);
        return;
      }
      // The client does not reconnect after a terminal disconnect code.
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
        if (client !== this.#client) return;
        this.#failPendingStart = undefined;
        // A connection that proved stable ended its outage even if it came back without an error
        // in between: whatever fails on this new connection begins a new one.
        this.#endOutageIfStable(this.#nowMs());
        this.#connectFailure = undefined;
        const reconnect = this.#hasConnected;
        this.#connected = true;
        this.#hasConnected = true;
        this.#markInbound();
        logger.info("Daemon cloud connection established", {
          event: "daemon_connection:connected",
          ...scope,
          control_stream_binding: "connect_proxy",
          outcome: "ok",
        });
        this.#reportOnline(client, config);
        // Invalidate before Activity on reconnect.
        this.#flushPendingSessionInvalidate(client);
        this.#flushPendingActivity(client);
        this.#observations.flush(client);
        for (const status of this.#latestStatuses.values()) this.#queueAgentStatus(client, status);
        this.#startStatusRefresh(config);
        if (reconnect && this.#readyRequestFactory) {
          this.#readyPublications ??= new HeldPublications();
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
        // A failed attempt the client retries with its own backoff, first connect included: a
        // temporary connect error (the connect proxy failing, or answering non-200) or a
        // transport that closed before it opened.
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
        this.#client = undefined;
        client.disconnect();
        throw error;
      })
      .finally(() => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      });
  }

  /** A failure after a connection that proved stable begins a new outage; after any other
   * connection it continues the one before. */
  #endOutageIfStable(now: number): void {
    if (this.#stableSinceMs !== undefined && now - this.#stableSinceMs >= STABLE_CONNECTION_MS)
      this.#outage = undefined;
    this.#stableSinceMs = undefined;
  }

  /** Logs one failed connect attempt; a run of them escalates to an error naming the outage. */
  #recordConnectFailure(failure: string, details: Record<string, unknown>): ConnectOutage {
    const now = this.#nowMs();
    this.#endOutageIfStable(now);
    this.#connectFailure = failure;
    // The connection itself is what fails now; a ready failure from before no longer describes it.
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

  /**
   * The client stopped reconnecting for a reason that is not a refusal for good: a non-temporary
   * connect error, a server disconnect code in 3500-3999, or a message over the size limit. None
   * of them says this Workspace may never connect again, so the connection connects the client
   * again after its own backoff, first connect included, instead of staying offline until a
   * person restarts the Computer.
   */
  #resumeAfterGiveUp(
    client: CentrifugeWorkspaceClient,
    scope: Record<string, unknown>,
    disconnect: { code: number; reason: string } | undefined,
  ): void {
    // Before reading `resumes`: after a stable connection this drop begins a new outage.
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

  /** Why the latest connect attempt failed, while the connection is not up; `undefined` once it
   * is. Remote text: a caller that prints it must make it terminal-safe. */
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

  onReminderSync(callback: (sync: ReminderSync) => void): () => void {
    return this.#reminderSync.set(callback);
  }

  onAppConfigSync(callback: (sync: AppConfigSync) => void): () => void {
    return this.#appConfigSync.set(callback);
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

  readonly onSkillsList = this.#queries.skills.onRequest;
  readonly sendSkillsListResult = this.#queries.skills.sendResult;
  readonly onWorkspaceFilesList = this.#queries.files.onRequest;
  readonly sendWorkspaceFilesListResult = this.#queries.files.sendResult;
  readonly onWorkspaceFileRead = this.#queries.file.onRequest;
  readonly sendWorkspaceFileReadResult = this.#queries.file.sendResult;
  readonly onWorkspaceDelete = this.#queries.deletion.onRequest;
  readonly sendWorkspaceDeleteResult = this.#queries.deletion.sendResult;
  readonly onPiChatRequest = this.#queries.piChat.onRequest;
  readonly sendPiChatFrame = this.#queries.piChat.sendResult;

  onUsageScan(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void {
    return this.#usageScan.set(callback);
  }

  onProviderModelRefresh(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void {
    return this.#providerModelRefresh.set(callback);
  }

  onReconnect(callback: () => void): () => void {
    return this.#reconnect.set(callback);
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
    this.#publishActivity(this.#client, activity.workspaceId, encodeAgentActivity(activity));
  }

  sendAgentReplyIntent(frame: AgentReplyIntent): void {
    const client = this.#activeClient();
    if (client) this.#publishActivity(client, frame.workspaceId, encodeAgentReplyIntent(frame));
  }

  /** Fire-and-forget; never awaited by a caller and never fails a launch. */
  sendSessionInvalidate(message: AgentSessionInvalidate): void {
    if (this.#supersededActivityLaunches.get(message.agentId)?.has(message.launchId)) return;
    if (!this.#connected || !this.#client) {
      // Refuse to queue a new invalidate whose launch is already known stale — never learned
      // from Activity or from an invalidate itself, only from another outbound message that
      // carries launch identity (`#observeLaunchIdentity`).
      const observed = this.#latestObservedLaunchByAgent.get(message.agentId);
      if (observed !== undefined && observed !== message.launchId) return;
      this.#pendingSessionInvalidate.set(message.agentId, message);
      return;
    }
    this.#publishSessionInvalidate(this.#client, message);
  }

  /** Fire-and-forget; never awaited by a caller and never fails a turn. */
  sendAgentContextUsage(message: AgentContextUsage): void {
    this.#observations.sendContextUsage(message, this.#activeClient());
  }

  /** Fire-and-forget; never awaited by a caller and never fails a turn. */
  sendAgentServiceTier(message: AgentServiceTier): void {
    this.#observations.sendServiceTier(message, this.#activeClient());
  }

  #activeClient(): CentrifugeWorkspaceClient | undefined {
    return this.#connected ? this.#client : undefined;
  }

  sendAgentStatus(status: AgentStatus): void {
    this.#latestStatuses.set(status.agentId, status);
    if (this.#connected && this.#client) this.#queueAgentStatus(this.#client, status);
  }

  /**
   * Only an outbound message that is neither Activity nor a session invalidate itself teaches
   * this connection which launch is now current for an Agent. Drops a pending invalidate whose
   * launch differs from the one just observed — the correctly-directional replacement for the
   * old rule that dropped it on ANY differing-launch Activity, including a late Activity from
   * an OLDER launch that would have wrongly dropped a NEWER pending invalidate.
   */
  #observeLaunchIdentity(agentId: string, launchId: string): void {
    this.#latestObservedLaunchByAgent.set(agentId, launchId);
    const pending = this.#pendingSessionInvalidate.get(agentId);
    if (pending && pending.launchId !== launchId) this.#pendingSessionInvalidate.delete(agentId);
  }

  /** Puts an encoded Activity-channel frame (an observation or a reply intent) on the Workspace's
   * channel. It is an observation: failure must not block Agent work or be retried. */
  #publishActivity(
    client: CentrifugeWorkspaceClient,
    workspaceId: string,
    frame: Uint8Array,
  ): void {
    void client.publish?.(`agent:activity:${workspaceId}`, frame).catch(() => {});
  }

  #flushPendingActivity(client: CentrifugeWorkspaceClient): void {
    if (!client.publish) return;
    const pending = [...this.#pendingActivity.values()];
    this.#pendingActivity.clear();
    this.#supersededActivityLaunches.clear();
    for (const activity of pending)
      this.#publishActivity(client, activity.workspaceId, encodeAgentActivity(activity));
  }

  #publishSessionInvalidate(
    client: CentrifugeWorkspaceClient,
    message: AgentSessionInvalidate,
  ): void {
    // An observation, not a command: a rejection (including an old server that does not
    // recognize this RPC) is logged, never retried or surfaced to the caller.
    void client
      .rpc(AGENT_SESSION_INVALIDATE_METHOD, encodeAgentSessionInvalidate(message))
      .catch((error) => {
        const errorCode = diagnosticErrorCode(error);
        // An old server that has never heard of this RPC rejects every attempt the same way for
        // as long as this process talks to it; logging that fact once per connection lifetime is
        // enough. Any other rejection (a genuine, potentially transient failure) still logs every
        // time, like the sibling `agent_session:report_failed`.
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

  #reportOnline(client: CentrifugeWorkspaceClient, config: DaemonConnectionConfig): void {
    void client
      .rpc(
        DAEMON_CONNECTION_STATUS_METHOD,
        utf8Encoder.encode(
          JSON.stringify({
            workspaceId: config.workspaceId,
            computerId: config.computerId,
            online: true,
          }),
        ),
      )
      .catch(() => {});
  }

  #startStatusRefresh(config: DaemonConnectionConfig): void {
    if (!this.#statusRefreshTimer) {
      this.#statusRefreshTimer = setInterval(() => {
        const client = this.#client;
        if (!this.#connected || !client) return;
        for (const status of this.#latestStatuses.values()) {
          if (status.status !== "active") continue;
          this.#queueAgentStatus(client, { ...status, requestId: crypto.randomUUID() });
        }
      }, AGENT_STATUS_REFRESH_MS);
      this.#statusRefreshTimer.unref();
    }

    if (this.#computerStatusRefreshTimer) return;
    const refresh = () => {
      const client = this.#client;
      if (!this.#connected || !client) return;
      this.#checkInboundLiveness(client, config);
      void client
        .rpc(
          DAEMON_CONNECTION_STATUS_METHOD,
          utf8Encoder.encode(JSON.stringify({ ...config, online: true })),
        )
        .then(() => {
          // An answered round trip is the only inbound traffic a Workspace with nothing to say
          // produces, so it is what keeps a legitimately quiet connection alive.
          if (client === this.#client) this.#markInbound();
        })
        .catch(() => {});
    };
    this.#computerStatusRefreshTimer = this.timing.scheduleRepeating
      ? this.timing.scheduleRepeating(refresh, COMPUTER_STATUS_REFRESH_MS)
      : setInterval(refresh, COMPUTER_STATUS_REFRESH_MS);
    if (!this.timing.scheduleRepeating) {
      (this.#computerStatusRefreshTimer as ReturnType<typeof setInterval>).unref();
    }
  }

  #nowMs(): number {
    return this.timing.now ? this.timing.now() : Date.now();
  }

  #markInbound(): void {
    this.#lastInboundAtMs = this.#nowMs();
    this.#loggedInboundQuiet = false;
  }

  /**
   * Decides, once per status refresh, whether this connection is still worth believing.
   *
   * A socket that stays open is not evidence that anything reaches this Daemon: the incident
   * this answers kept its socket and its subscription while every control frame it delivered was
   * dropped as undecodable, and the Agent behind it stayed silent until a person restarted the
   * Computer. Rebuilding the connection is the one recovery that does not need that person.
   */
  #checkInboundLiveness(client: CentrifugeWorkspaceClient, config: DaemonConnectionConfig): void {
    if (this.#lastInboundAtMs === undefined) return;
    const ageMs = this.#nowMs() - this.#lastInboundAtMs;
    const liveness = connectionLiveness(ageMs);
    if (liveness === "carrying") return;
    const scope = { workspace_id: config.workspaceId, computer_id: config.computerId };
    if (liveness === "quiet") {
      if (this.#loggedInboundQuiet) return;
      this.#loggedInboundQuiet = true;
      logger.info("Daemon cloud connection has carried nothing recently", {
        event: "daemon_connection:inbound_quiet",
        ...scope,
        last_inbound_age_ms: ageMs,
        rebuild_after_ms: INBOUND_STALLED_MS,
      });
      return;
    }
    logger.warning("Daemon cloud connection carried nothing; rebuilding it", {
      event: "daemon_connection:inbound_stalled",
      ...scope,
      last_inbound_age_ms: ageMs,
      outcome: "reconnecting",
    });
    // Counts as fresh traffic so a connection that takes a while to come back is rebuilt once
    // per window rather than on every refresh while it reconnects.
    this.#markInbound();
    client.disconnect();
    client.connect();
  }

  /** Refuses an Agent request while this connection is not up: each one needs the server. */
  #assertConnected(): void {
    if (!this.#connected) throw new Error("daemon connection is not connected");
  }

  #requireClient(): CentrifugeWorkspaceClient {
    if (!this.#connected || !this.#client) throw new Error("daemon connection is not connected");
    return this.#client;
  }

  /** Sends one RPC over the connected client and returns its raw reply. */
  #rpc(method: string, data: Uint8Array): Promise<unknown> {
    return this.#requireClient().rpc(method, data);
  }

  /** The URL of an Agent message route. */
  #messageEndpoint(path: string): string {
    return this.#serverEndpoint("Agent message HTTP", path);
  }

  /** The server endpoint for one Agent HTTP path; `what` names the caller in the error. */
  #serverEndpoint(what: string, path: string): string {
    if (!this.#serverHttpUrl) throw new Error(`${what} endpoint is not configured`);
    return `${new URL(this.#serverHttpUrl).origin}${path}`;
  }

  async sendAgentDeliveryAck(ack: AgentMessageDeliveryAck): Promise<void> {
    await this.#rpc(AGENT_MESSAGE_ACK_METHOD, encodeAgentMessageDeliveryAck(ack));
  }

  async sendAgentDeliveryRejection(rejection: AgentMessageDeliveryRejection): Promise<void> {
    await this.#rpc(AGENT_MESSAGE_REJECT_METHOD, encodeAgentMessageDeliveryRejection(rejection));
  }

  async sendAgentMentionDeliveryTransition(report: AgentMentionDeliveryTransition): Promise<void> {
    await this.#rpc(
      AGENT_MENTION_DELIVERY_TRANSITION_METHOD,
      encodeAgentMentionDeliveryTransition(report),
    );
  }

  async sendAgentMentionDeliveryTerminalError(
    report: AgentMentionDeliveryTerminalError,
  ): Promise<void> {
    await this.#rpc(
      AGENT_MENTION_DELIVERY_TERMINAL_ERROR_METHOD,
      encodeAgentMentionDeliveryTerminalError(report),
    );
  }

  /** The server's Agent migration route, over HTTPS with this daemon's API key. */
  agentMigrationServer(): AgentMigrationServer {
    return new AgentMigrationHttpClient({
      endpoint: () => this.#serverEndpoint("Agent migration", "/api/daemon/agent-migrations"),
      daemonApiKey: () => this.#token,
    });
  }

  /** Credentials for one Agent-scoped HTTP call: the Agent's own key plus the daemon key. */
  #agentKeys(agentApiKey: string) {
    return { agentApiKey, daemonApiKey: this.#token };
  }

  async agentMessage(
    request: AgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageTransportResponse> {
    this.#assertConnected();
    const {
      requestRead,
      requestSearch,
      requestSend,
      requestResolve,
      requestReaction,
      requestEvents,
      requestChannelMute,
      requestThreadUnfollow,
    } = this.agentMessageHttpClient;
    if (request.operation === "check") {
      if (!requestEvents) throw new Error("unsupported Agent message operation: check");
      const url = this.#messageEndpoint(agentApiRoutes.cloud.events.path);
      const events = await requestEvents({ url, ...this.#agentKeys(agentApiKey), request });
      return {
        idempotencyKey: events.idempotencyKey,
        accepted: true,
        attentionCount: events.events.length,
        messages: events.events,
        messageId: "",
        hasMore: events.hasMore,
      };
    }
    if (request.operation === "mute" || request.operation === "unmute") {
      if (!requestChannelMute)
        throw new Error(`unsupported Agent message operation: ${request.operation}`);
      const muted = request.operation === "mute";
      const path = muted
        ? agentApiRoutes.cloud.channels.mute.path(request.target)
        : agentApiRoutes.cloud.channels.unmute.path(request.target);
      const url = this.#messageEndpoint(path);
      const result = await requestChannelMute({
        url,
        ...this.#agentKeys(agentApiKey),
        request: { ...request, muted },
      });
      return {
        idempotencyKey: result.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
        messageId: "",
      };
    }
    if (request.operation === "thread-unfollow") {
      if (!requestThreadUnfollow)
        throw new Error("unsupported Agent message operation: thread-unfollow");
      const url = this.#messageEndpoint(agentApiRoutes.cloud.threads.unfollow.path(request.target));
      const result = await requestThreadUnfollow({ url, ...this.#agentKeys(agentApiKey), request });
      return {
        idempotencyKey: result.idempotencyKey,
        accepted: true,
        attentionCount: 0,
        messages: [],
        messageId: "",
      };
    }
    if (request.operation === "resolve") {
      if (!requestResolve) throw new Error("unsupported Agent message operation: resolve");
      const url = this.#messageEndpoint(
        agentApiRoutes.cloud.messages.resolve.path(request.messageId ?? ""),
      );
      return adaptAgentResolveResponse(
        await requestResolve({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "react" || request.operation === "unreact") {
      if (!requestReaction)
        throw new Error(`unsupported Agent message operation: ${request.operation}`);
      const url = this.#messageEndpoint(
        agentApiRoutes.cloud.messages.reactions.path(request.messageId ?? ""),
      );
      const method =
        request.operation === "react"
          ? agentApiRoutes.cloud.messages.reactions.add.method
          : agentApiRoutes.cloud.messages.reactions.remove.method;
      return adaptAgentReactionResponse(
        await requestReaction({ url, method, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "read") {
      if (!requestRead) throw new Error("unsupported Agent message operation: read");
      const url = this.#messageEndpoint(agentApiRoutes.cloud.messages.list.path);
      return adaptAgentHistoryResponse(
        await requestRead({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "search") {
      if (!requestSearch) throw new Error("unsupported Agent message operation: search");
      const url = this.#messageEndpoint(agentApiRoutes.cloud.messages.search.path);
      return adaptAgentSearchResponse(
        await requestSearch({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    if (request.operation === "send") {
      if (!requestSend) throw new Error("unsupported Agent message operation: send");
      const url = this.#messageEndpoint(agentApiRoutes.cloud.messages.send.path);
      return adaptAgentSendResponse(
        await requestSend({ url, ...this.#agentKeys(agentApiKey), request }),
      );
    }
    throw new Error(`unsupported Agent message operation: ${request.operation}`);
  }

  async reconcileAgentSend(
    request: AgentSendReconciliationRequest,
    agentApiKey: string,
  ): Promise<AgentSendReconciliationResponse> {
    this.#assertConnected();
    const { requestSendReconciliation } = this.agentMessageHttpClient;
    if (!requestSendReconciliation)
      throw new Error("unsupported Agent message operation: send reconciliation");
    return requestSendReconciliation({
      url: this.#messageEndpoint(agentApiRoutes.cloud.messages.send.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async workspaceInfo(
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse> {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("Agent workspace_info HTTP endpoint is not configured");
    if (!this.agentMessageHttpClient.requestWorkspaceInfo)
      throw new Error("Agent workspace_info HTTP client is unavailable");
    return this.agentMessageHttpClient.requestWorkspaceInfo({
      url: this.#serverEndpoint("Agent workspace_info", agentApiRoutes.cloud.workspace.info.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async githubCredential(request: GitHubCredentialRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestGitHubCredential;
    return this.#agentGet(
      "GitHub credential",
      "GitHub credential",
      client,
      agentApiRoutes.cloud.githubCredentials.path,
      request,
      agentApiKey,
    );
  }

  async githubCommitTrailers(request: GitHubCommitTrailersRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestGitHubCommitTrailers;
    return this.#agentGet(
      "GitHub commit trailers",
      "GitHub commit trailers",
      client,
      agentApiRoutes.cloud.githubCommitTrailers.path,
      request,
      agentApiKey,
    );
  }

  async manualGet(request: AgentManualGetRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestManualGet;
    return this.#agentGet(
      "Agent Manual",
      "Agent manual get",
      client,
      agentApiRoutes.cloud.manual.get.path,
      request,
      agentApiKey,
    );
  }

  async manualSearch(request: AgentManualSearchRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestManualSearch;
    return this.#agentGet(
      "Agent Manual",
      "Agent manual search",
      client,
      agentApiRoutes.cloud.manual.search.path,
      request,
      agentApiKey,
    );
  }

  async userInfo(request: AgentUserInfoRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestUserInfo;
    return this.#agentGet(
      "Agent user info",
      "Agent user info",
      client,
      agentApiRoutes.cloud.users.path(request.name),
      request,
      agentApiKey,
    );
  }

  async profileShow(request: AgentProfileShowRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestProfileShow;
    return this.#agentGet(
      "Agent profile",
      "Agent profile show",
      client,
      agentApiRoutes.cloud.profile.get.path,
      request,
      agentApiKey,
    );
  }

  async profileUpdate(request: AgentProfileUpdateRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestProfileUpdate;
    return this.#agentGet(
      "Agent profile",
      "Agent profile update",
      client,
      agentApiRoutes.cloud.profile.update.path,
      request,
      agentApiKey,
    );
  }

  async appConfigGet(request: AgentAppConfigGetRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestAppConfigGet;
    return this.#agentGet(
      "Agent app config",
      "Agent app config get",
      client,
      agentApiRoutes.cloud.appConfig.get.path(request.appId),
      request,
      agentApiKey,
    );
  }

  async appConfigUpdate(request: AgentAppConfigUpdateRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestAppConfigUpdate;
    return this.#agentGet(
      "Agent app config",
      "Agent app config update",
      client,
      agentApiRoutes.cloud.appConfig.update.path(request.appId),
      request,
      agentApiKey,
    );
  }

  /** A forwarded Agent request needs a connected daemon and the HTTP client for its route. */
  #requireAgentClient(label: string, client: unknown): void {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error(`${label} endpoint is not configured`);
    if (!client) throw new Error(`${label} HTTP client is unavailable`);
  }

  /** One GET through a route's HTTP client with the Agent's keys. */
  #agentGet<I, O>(
    label: string,
    endpoint: string,
    client: ((input: AgentHttpInput<I>) => Promise<O>) | undefined,
    path: string,
    request: I,
    agentApiKey: string,
  ): Promise<O> {
    this.#requireAgentClient(label, client);
    return client!({
      url: this.#serverEndpoint(endpoint, path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  inboxList(request: AgentInboxRequest, agentApiKey: string): Promise<AgentInboxListResponse> {
    const client = this.agentMessageHttpClient.requestInboxList;
    return this.#agentGet(
      "Agent inbox list",
      "Agent inbox list",
      client,
      agentApiRoutes.cloud.inboxList.path,
      request,
      agentApiKey,
    );
  }

  threadList(agentApiKey: string): Promise<AgentThreadListResponse> {
    const client = this.agentMessageHttpClient.requestThreadList;
    return this.#agentGet(
      "Agent thread list",
      "Agent thread list",
      client,
      agentApiRoutes.cloud.threadList.path,
      {},
      agentApiKey,
    );
  }

  mentionPending(request: AgentMentionPendingRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestMentionPending;
    return this.#agentGet(
      "Agent mention actions",
      "Agent mention pending",
      client,
      agentApiRoutes.cloud.mentionActions.pending.path,
      request,
      agentApiKey,
    );
  }

  async mentionExecute(request: AgentMentionExecuteRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestMentionExecute;
    return this.#agentGet(
      "Agent mention actions",
      "Agent mention action",
      client,
      agentApiRoutes.cloud.mentionActions.execute.path,
      request,
      agentApiKey,
    );
  }

  attachmentComments(request: AgentAttachmentCommentsRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestAttachmentComments;
    return this.#agentGet(
      "Agent attachment comments",
      "Agent attachment comments",
      client,
      agentApiRoutes.cloud.attachmentComments.path(request.attachmentId),
      request,
      agentApiKey,
    );
  }

  async mentionDelivery(request: AgentMentionDeliveryRequest, agentApiKey: string) {
    const client = this.agentMessageHttpClient.requestMentionDelivery;
    return this.#agentGet(
      "Agent mention delivery",
      "Agent mention delivery",
      client,
      agentApiRoutes.cloud.mentionDeliveries.path(request.messageId),
      request,
      agentApiKey,
    );
  }

  async agentReminder(request: AgentReminderOperationRequest, agentApiKey: string) {
    if (!this.#connected || !this.#serverHttpUrl)
      throw new Error("daemon connection is not connected");
    if (!this.agentMessageHttpClient.requestReminder)
      throw new Error("Agent reminder HTTP client is unavailable");
    const response = await this.agentMessageHttpClient.requestReminder({
      url: this.#serverEndpoint("Agent reminder", agentApiRoutes.cloud.reminders.path),
      agentApiKey,
      daemonApiKey: this.#token,
      request,
    });
    for (const field of ["idempotencyKey", "workspaceId", "computerId", "agentId"] as const)
      if (response[field] !== request[field])
        throw new Error("uncorrelated Agent reminder response");
    return response;
  }

  async fireReminder(request: ReminderFireRequest): Promise<ReminderFireResponse> {
    const reply = await this.#rpc(REMINDER_FIRE_METHOD, encodeReminderFireRequest(request));
    return decodeReminderFireResponse(rpcData(reply));
  }

  async requestSnapshot(request: ReminderSnapshotRequest): Promise<ReminderSync> {
    const reply = await this.#rpc(REMINDER_SNAPSHOT_METHOD, encodeReminderSnapshotRequest(request));
    return decodeReminderSync(rpcData(reply));
  }

  async requestAppConfigSnapshot(request: AppConfigSnapshotRequest): Promise<AppConfigSync> {
    const reply = await this.#rpc(
      APP_CONFIG_SNAPSHOT_METHOD,
      encodeAppConfigSnapshotRequest(request),
    );
    return decodeAppConfigSync(rpcData(reply));
  }

  async agentMemoryDisposition(request: unknown, agentApiKey: string): Promise<unknown> {
    this.#assertConnected();
    return sendAgentJson(fetch, {
      url: this.#serverEndpoint(
        "Agent Memory disposition",
        agentApiRoutes.cloud.memoryDisposition.path,
      ),
      agentApiKey,
      daemonApiKey: this.#token,
      method: "POST",
      body: request,
      what: "Memory disposition",
      timeoutMs: 30_000,
    });
  }

  async agentOpenviking(
    request: OpenVikingAgentProxyCommand,
    agentApiKey: string,
  ): Promise<unknown> {
    this.#assertConnected();
    const url = this.#serverEndpoint("Agent OpenViking HTTP", agentApiRoutes.cloud.openviking.path);
    if (request.op === "offer" || request.op === "diagnose") {
      return forwardOpenVikingControl({
        url,
        command: request,
        agentApiKey,
        daemonApiKey: this.#token,
      });
    }
    return forwardOpenVikingRead({
      url,
      command: request,
      agentApiKey,
      daemonApiKey: this.#token,
    });
  }

  async agentTask(request: TaskRequest, agentApiKey: string): Promise<TaskResponse> {
    this.#assertConnected();
    return this.agentTaskHttpClient.execute({
      url: this.#serverEndpoint("Agent Task HTTP", agentApiRoutes.cloud.tasks.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentChannel(
    request: AgentChannelRequest,
    agentApiKey: string,
  ): Promise<Record<string, unknown>> {
    this.#assertConnected();
    const endpoint = channelEndpointFor(request.operation, request.target);
    return this.agentChannelHttpClient.execute({
      method: endpoint.method,
      url: this.#serverEndpoint("Agent channel", endpoint.path),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentActionPrepare(
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse> {
    this.#assertConnected();
    return this.agentActionPrepareHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent action-prepare HTTP",
        agentApiRoutes.cloud.actionPrepare.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReport(
    request: WeeklyReportRequest,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse> {
    this.#assertConnected();
    return this.agentWeeklyReportHttpClient.request({
      url: this.#serverEndpoint(
        "Agent weekly-report HTTP",
        agentApiRoutes.cloud.weeklyReports.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReportCollect(
    request:
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult> {
    this.#assertConnected();
    return defaultAgentWeeklyReportCollectHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent weekly-report-collect HTTP",
        agentApiRoutes.cloud.weeklyReportCollect.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReportKeyPoints(
    request: import("./weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult> {
    this.#assertConnected();
    return defaultAgentWeeklyReportKeyPointsHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent weekly-report-key-points HTTP",
        agentApiRoutes.cloud.weeklyReportKeyPoints.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentWeeklyReportMemory(
    request: import("./weekly-report-memory").WeeklyReportMemoryCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-memory").WeeklyReportMemoryResult> {
    if (!this.#connected) throw new Error("daemon connection is not connected");
    return defaultAgentWeeklyReportMemoryHttpClient.execute({
      url: this.#serverEndpoint(
        "Agent weekly-report-memory HTTP",
        agentApiRoutes.cloud.weeklyReportMemory.path,
      ),
      ...this.#agentKeys(agentApiKey),
      request,
    });
  }

  async agentAttachment(attachmentId: string, agentApiKey: string): Promise<Response> {
    this.#assertConnected();
    return fetch(
      this.#serverEndpoint("Agent attachment", agentApiRoutes.cloud.attachments.path(attachmentId)),
      // The local proxy forwards these bytes and their encoding/length headers unchanged.
      { headers: agentHeaders(this.#agentKeys(agentApiKey)), decompress: false },
    );
  }

  /**
   * Forwards a multipart upload to the cloud attachment-upload route. Buffered to a `Blob`
   * rather than streamed: the local proxy already caps the body well under the size the daemon
   * can hold in memory, and buffering avoids depending on `duplex: "half"` for a streamed
   * `fetch` body. The original request's `content-type` (its multipart boundary) is forwarded
   * unchanged; only the Agent-scoped authorization headers are added.
   */
  async agentAttachmentUpload(request: Request, agentApiKey: string): Promise<Response> {
    this.#assertConnected();
    const contentType = request.headers.get("content-type");
    if (!contentType) throw new Error("multipart content-type is missing");
    const body = await request.blob();
    return fetch(
      this.#serverEndpoint("Agent attachment upload", agentApiRoutes.cloud.attachments.upload.path),
      {
        decompress: false,
        method: agentApiRoutes.cloud.attachments.upload.method,
        headers: { ...agentHeaders(this.#agentKeys(agentApiKey)), "content-type": contentType },
        body,
      },
    );
  }

  /**
   * The direct-upload session routes are plain JSON, unlike the multipart upload
   * above; each simply forwards its body (if any) to the matching cloud route with the same
   * Agent-scoped headers `agentAttachment`/`agentAttachmentUpload` already add.
   */
  async agentAttachmentUploadSessionCreate(body: unknown, agentApiKey: string): Promise<Response> {
    this.#assertConnected();
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session create",
        agentApiRoutes.cloud.attachmentUploadSessions.create.path,
      ),
      {
        decompress: false,
        method: agentApiRoutes.cloud.attachmentUploadSessions.create.method,
        headers: agentHeaders(this.#agentKeys(agentApiKey), true),
        body: JSON.stringify(body),
      },
    );
  }

  async agentAttachmentUploadSessionComplete(
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#assertConnected();
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session complete",
        agentApiRoutes.cloud.attachmentUploadSessions.complete.path(uploadId),
      ),
      {
        decompress: false,
        method: agentApiRoutes.cloud.attachmentUploadSessions.complete.method,
        headers: agentHeaders(this.#agentKeys(agentApiKey)),
      },
    );
  }

  async agentAttachmentUploadSessionCancel(
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#assertConnected();
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session cancel",
        agentApiRoutes.cloud.attachmentUploadSessions.cancel.path(uploadId),
      ),
      {
        decompress: false,
        method: agentApiRoutes.cloud.attachmentUploadSessions.cancel.method,
        headers: agentHeaders(this.#agentKeys(agentApiKey)),
      },
    );
  }

  async agentAttachmentUploadSessionGet(uploadId: string, agentApiKey: string): Promise<Response> {
    this.#assertConnected();
    return fetch(
      this.#serverEndpoint(
        "Agent attachment upload session get",
        agentApiRoutes.cloud.attachmentUploadSessions.get.path(uploadId),
      ),
      { headers: agentHeaders(this.#agentKeys(agentApiKey)), decompress: false },
    );
  }

  /** `coforge app list|token`, sent on as it is; the cloud's response is the Agent's answer. */
  async agentApp(request: AgentAppRequest, agentApiKey: string): Promise<Response> {
    this.#assertConnected();
    const { method, path, body } = agentAppCloudRequest(request);
    return fetch(this.#serverEndpoint(`Agent app ${request.operation}`, path), {
      decompress: false,
      method,
      headers: agentHeaders(this.#agentKeys(agentApiKey), body !== undefined),
      ...(body === undefined ? {} : { body }),
    });
  }

  /** One request against the Agent API key endpoint; `what` names the caller in errors. */
  async #agentApiKeyRequest(what: string, method: "POST" | "DELETE", body: unknown) {
    const response = await fetch(this.#serverEndpoint(what, "/api/agent-api-keys"), {
      method,
      headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${what} request failed (${response.status})`);
    return response;
  }

  async requestAgentApiKey(input: { agentId: string; workspaceId: string }): Promise<string> {
    const value = (await (
      await this.#agentApiKeyRequest("Agent API key", "POST", input)
    ).json()) as {
      apiKey?: unknown;
    };
    return parseAgentApiKey(value.apiKey);
  }

  async requestAgentLaunchConfig(input: {
    agentId: string;
    workspaceId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  }): Promise<AgentLaunchConfig> {
    const value = (await (
      await this.#agentApiKeyRequest("Agent launch config", "POST", input)
    ).json()) as {
      apiKey?: unknown;
      providerConfig?: unknown;
      envVars?: unknown;
      assignedSkillPacks?: unknown;
      identity?: unknown;
    };
    const providerConfig = parseAgentRuntimeProviderConfig(value.providerConfig);
    const assignedSkillPacks = Array.isArray(value.assignedSkillPacks)
      ? value.assignedSkillPacks.filter((entry): entry is string => typeof entry === "string")
      : [];
    const identity = parseAgentLaunchIdentity(value.identity);
    return {
      agentApiKey: parseAgentApiKey(value.apiKey),
      ...(providerConfig ? { providerConfig } : {}),
      envVars: parseAgentEnvironment(value.envVars),
      ...(assignedSkillPacks.length > 0 ? { assignedSkillPacks } : {}),
      ...(identity ? { identity } : {}),
    };
  }

  async revokeAgentApiKey(agentApiKey: string): Promise<void> {
    await this.#agentApiKeyRequest("Agent API key revoke", "DELETE", { apiKey: agentApiKey });
  }

  /**
   * Delivers to a listener now, or after the in-flight ready handshake completes. While held, an
   * item with a `key` replaces the earlier one under it, and a delivery `notice` is capped.
   */
  #deliver<Value extends { agentId?: string }>(
    slot: ListenerSlot<(value: Value) => void>,
    value: Value,
    hold?: "start" | "stop" | "probe" | "notice",
  ): void {
    const held = this.#readyPublications;
    // The common case: nothing is held, so nothing is allocated either.
    if (!held) return void slot.current?.(value);
    const run = () => slot.current?.(value);
    const agentId = value.agentId ?? "";
    if (hold === "notice") held.notice(agentId, run);
    else if (hold) held.latestFor(agentId, hold, run);
    else held.add(run);
  }

  /**
   * Decodes `data` as one publication kind and lets `accept` handle it. Returns whether the
   * publication was consumed; a decode failure or a rejected `accept` moves on to the next kind.
   */
  #route<Value>(
    data: Uint8Array,
    decode: (data: Uint8Array) => Value,
    accept: (value: Value) => boolean,
  ) {
    try {
      return accept(decode(data));
    } catch {
      return false;
    }
  }

  /** Runs one Computer lifecycle request at most once per request ID. */
  #acceptLifecycleRequest(seen: Set<string>, requestId: string, run: () => Promise<void>): void {
    if (seen.size >= REMEMBERED_REQUEST_IDS) seen.delete(seen.values().next().value!);
    seen.add(requestId);
    try {
      void run().catch(() => {
        seen.delete(requestId);
      });
    } catch (error) {
      seen.delete(requestId);
      throw error;
    }
  }

  #handleAgentPublication(data: Uint8Array, config: DaemonConnectionConfig): void {
    const { workspaceId, computerId } = config;
    const ownsDaemon = (value: { workspaceId: string; computerId?: string }) =>
      value.workspaceId === workspaceId && value.computerId === computerId;
    const handled =
      this.#route(data, decodeRuntimeAuthIntent, (intent) => {
        if (ownsDaemon(intent)) this.#runtimeAuthIntent.current?.(intent);
        return true;
      }) ||
      this.#queries.receive(data, config) ||
      this.#route(data, decodeReminderSync, (sync) => {
        if (sync.messageType !== REMINDER_SYNC_MESSAGE_TYPE || !ownsDaemon(sync)) return false;
        this.#deliver(this.#reminderSync, sync);
        return true;
      }) ||
      this.#route(data, decodeAppConfigSync, (sync) => {
        // The decoder already refuses any other message type.
        if (!ownsDaemon(sync)) return false;
        this.#deliver(this.#appConfigSync, sync);
        return true;
      }) ||
      this.#route(data, decodeAppRegistrationNotice, (notice) => {
        if (!ownsDaemon(notice)) return false;
        this.#deliver(this.#appRegistrationNotice, notice);
        return true;
      }) ||
      this.#route(data, decodeAgentMigrationLease, (lease) => {
        if (!ownsDaemon(lease)) return false;
        // The lease runs from its arrival here, so no clock is compared with the server's.
        this.#deliver(this.#agentMigrationLease, {
          ...lease,
          deadline: Date.now() + lease.expiresInMs,
        });
        return true;
      }) ||
      this.#route(data, decodeAgentMigrationCancel, (cancel) => {
        if (!ownsDaemon(cancel)) return false;
        this.#deliver(this.#agentMigrationCancel, cancel);
        return true;
      }) ||
      this.#route(data, decodeComputerUpgradeIntent, (upgrade) => {
        const requestUpgrade = config.requestUpgrade;
        if (
          upgrade.protocolMajor !== 1 ||
          !ownsDaemon(upgrade) ||
          !requestUpgrade ||
          this.#upgradeRequestIds.has(upgrade.requestId)
        )
          return false;
        this.#acceptLifecycleRequest(this.#upgradeRequestIds, upgrade.requestId, () =>
          requestUpgrade(upgrade.requestId, upgrade.expectedVersion),
        );
        return true;
      }) ||
      this.#route(data, decodeComputerRestartIntent, (restart) => {
        const requestRestart = config.requestRestart;
        if (
          restart.protocolMajor !== 1 ||
          !ownsDaemon(restart) ||
          !requestRestart ||
          this.#restartRequestIds.has(restart.requestId)
        )
          return false;
        this.#acceptLifecycleRequest(this.#restartRequestIds, restart.requestId, () =>
          requestRestart(restart.requestId),
        );
        return true;
      }) ||
      this.#route(data, decodeAgentWorkspaceResetRequest, (request) => {
        if (request.workspaceId === workspaceId) this.#deliver(this.#agentWorkspaceReset, request);
        return true;
      }) ||
      this.#route(data, decodeDaemonRuntimeUsageScanRequest, (usage) => {
        if (usage.protocolMajor !== 1 || usage.workspaceId !== workspaceId || !usage.computerId)
          return false;
        void this.#usageScan.current?.(usage);
        return true;
      }) ||
      this.#route(data, decodeDaemonRuntimeProviderModelRefreshRequest, (refresh) => {
        if (
          refresh.protocolMajor !== 1 ||
          refresh.workspaceId !== workspaceId ||
          !refresh.computerId
        )
          return false;
        void this.#providerModelRefresh.current?.(refresh);
        return true;
      }) ||
      this.#route(data, decodeAgentActivityProbe, (probe) => {
        if (probe.protocolMajor !== 1 || !ownsDaemon(probe)) return false;
        this.#deliver(this.#agentActivityProbe, probe, "probe");
        return true;
      }) ||
      this.#route(data, decodeAgentInboxPurge, (purge) => {
        if (purge.protocolMajor !== 1 || !ownsDaemon(purge)) return false;
        this.#deliver(this.#agentInboxPurge, purge);
        return true;
      });
    if (handled) return;
    // Agent publications are the common case and must decode as exactly one intent kind.
    const decoders = [
      {
        kind: "agent_message",
        decode: () =>
          this.#deliver(
            this.#agentMessage,
            this.#ownedIntent(decodeAgentMessageDelivery(data), workspaceId),
            "notice",
          ),
      },
      {
        kind: "agent_stop",
        decode: () => {
          const intent = this.#ownedIntent(decodeAgentStopIntent(data), workspaceId);
          this.#deliver(this.#agentStop, intent, "stop");
        },
      },
      {
        kind: "agent_turn_interrupt",
        decode: () => {
          const intent = this.#ownedIntent(decodeAgentTurnInterruptIntent(data), workspaceId);
          if (!this.#readyPublications) this.#deliver(this.#agentTurnInterrupt, intent);
        },
      },
      {
        kind: "agent_start",
        decode: () => {
          const intent = this.#ownedIntent(decodeAgentStartIntent(data), workspaceId);
          this.#deliver(this.#agentStart, intent, "start");
        },
      },
    ];
    const rejections: { kind: string; error: unknown }[] = [];
    for (const { kind, decode } of decoders) {
      try {
        decode();
        return;
      } catch (error) {
        rejections.push({ kind, error });
      }
    }
    // Invalid publications are rejected at the protocol boundary and never reach the runtime.
    logger.warning("Rejected invalid Daemon control publication", {
      event: "daemon_control:rejected",
      workspace_id: workspaceId,
      computer_id: computerId,
      payload_bytes: data.byteLength,
      // Every decoder's own account, not just the last one's: each refuses for its own reason,
      // and reporting only the final attempt named a cause that belonged to a frame kind this
      // publication may never have been. An Agent that never woke leaves nothing else behind.
      rejections: rejections
        .map(({ kind, error }) => `${kind}: ${thrownMessage(error)}`)
        .join("; "),
      // The fields the payload carries, never their values, so a frame no decoder accepted can
      // still be matched against a schema without putting message text in the log.
      payload_shape: controlPayloadShape(data),
      error_code: diagnosticErrorCode(rejections.at(-1)?.error),
      outcome: "rejected",
    });
  }

  #ownedIntent<Intent extends { protocolMajor: number; workspaceId: string }>(
    intent: Intent,
    workspaceId: string,
  ): Intent {
    if (intent.protocolMajor !== 1 || intent.workspaceId !== workspaceId)
      throw new Error("agent intent targets another Workspace");
    return intent;
  }

  async sendAgentControlResult(result: AgentControlResult) {
    await this.#rpc(AGENT_CONTROL_RESULT_METHOD, encodeAgentControlResult(result));
  }
  async sendAgentTurnInterruptResult(result: AgentTurnInterruptResult) {
    await this.#rpc(AGENT_TURN_INTERRUPT_RESULT_METHOD, encodeAgentTurnInterruptResult(result));
  }

  /**
   * Reports one upgrade operation's terminal result. Returns whether this call was the one that
   * put it on the wire; a replay of an already reported operation is dropped, and a failed send
   * stays replayable, matching the dedupe discipline of the other lifecycle results.
   */
  async sendUpgradeResult(result: ComputerUpgradeResult): Promise<boolean> {
    if (this.#reportedUpgradeRequestIds.has(result.requestId)) return false;
    await this.#rpc(COMPUTER_UPGRADE_RESULT_METHOD, encodeComputerUpgradeResult(result));
    if (this.#reportedUpgradeRequestIds.size >= REMEMBERED_REQUEST_IDS)
      this.#reportedUpgradeRequestIds.delete(
        this.#reportedUpgradeRequestIds.values().next().value!,
      );
    this.#reportedUpgradeRequestIds.add(result.requestId);
    return true;
  }

  /**
   * Tells the server why this daemon is going down on purpose. Awaited, unlike the other
   * observations, because the connection closes right after it; bounded by
   * `DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS`, never retried, and a daemon that is not connected sends
   * nothing. Never throws: a notice that did not arrive must not fail the shutdown.
   */
  async sendShutdownNotice(notice: DaemonRuntimeShutdown): Promise<void> {
    const fields = {
      event: "daemon_connection:shutdown_notice",
      request_id: notice.requestId,
      workspace_id: notice.workspaceId,
      computer_id: notice.computerId,
      reason: notice.reason,
    };
    const client = this.#connected ? this.#client : undefined;
    if (!client) {
      logger.info("Shutdown notice not sent: not connected", {
        ...fields,
        outcome: "unknown",
        error_code: "not_connected",
      });
      return;
    }
    let timer: unknown;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = this.timing.schedule(() => resolve("timed_out"), DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS);
    });
    try {
      const answered = await Promise.race([
        client
          .rpc(DAEMON_RUNTIME_SHUTDOWN_METHOD, encodeDaemonRuntimeShutdown(notice))
          .then(() => "answered" as const),
        timedOut,
      ]);
      if (answered === "answered")
        logger.info("Shutdown notice sent", { ...fields, outcome: "ok" });
      else
        logger.warning("Shutdown notice got no answer in time", {
          ...fields,
          outcome: "unknown",
          error_code: "timeout",
          duration_ms: DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS,
        });
    } catch (error) {
      logger.warning("Shutdown notice was not accepted", {
        ...fields,
        outcome: "rejected",
        error_code: diagnosticErrorCode(error),
      });
    } finally {
      this.timing.cancel(timer);
    }
  }

  async sendUsageScanResult(response: DaemonRuntimeUsageScanResponse): Promise<void> {
    await this.#rpc(
      DAEMON_RUNTIME_USAGE_SCAN_RESULT_METHOD,
      encodeDaemonRuntimeUsageScanResponse(response),
    );
  }

  async sendProviderModelRefreshResult(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<void> {
    await this.#rpc(
      DAEMON_RUNTIME_MODEL_REFRESH_RESULT_METHOD,
      encodeDaemonRuntimeProviderModelRefreshResponse(response),
    );
  }

  async ready(createRequest: () => DaemonRuntimeReadyRequest, signal?: AbortSignal): Promise<void> {
    const client = this.#requireClient();
    signal?.throwIfAborted();
    this.#readyPublications = new HeldPublications();
    // The first ready takes the reconnect path: a failure is retried with the same backoff and
    // escalation instead of failing the start and leaving the Workspace connected but dead.
    this.#readyRequestFactory = createRequest;
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

  /** Gives up a first ready still retrying: its recovery stops and `ready` rejects. */
  #failFirstReady(error: unknown): void {
    if (!this.#firstReady) return;
    this.#cancelReadyRecovery();
    const firstReady = this.#firstReady;
    this.#firstReady = undefined;
    firstReady?.reject(error);
  }

  async updateCodeAgents(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void> {
    await this.#rpc(
      DAEMON_RUNTIME_CODE_AGENTS_UPDATE_METHOD,
      encodeDaemonRuntimeCodeAgentsUpdateRequest(request),
    );
  }

  async reportRuntimeAuthLogin(report: RuntimeAuthLoginReport): Promise<void> {
    await this.#rpc(RUNTIME_AUTH_LOGIN_REPORT_METHOD, encodeRuntimeAuthLoginReport(report));
  }

  async reportRuntimeAuthLogout(report: RuntimeAuthLogoutReport): Promise<void> {
    await this.#rpc(RUNTIME_AUTH_LOGOUT_REPORT_METHOD, encodeRuntimeAuthLogoutReport(report));
  }

  async reportRuntimeAuthStatus(report: RuntimeAuthStatusReport): Promise<void> {
    await this.#rpc(RUNTIME_AUTH_STATUS_REPORT_METHOD, encodeRuntimeAuthStatusReport(report));
  }

  async reportAgentSession(report: AgentSessionReport): Promise<void> {
    // Observed regardless of what follows: this is the daemon's own outbound intent to report
    // this launch, the signal `#observeLaunchIdentity` needs, independent of whether the RPC
    // below reaches the server.
    this.#observeLaunchIdentity(report.agentId, report.launchId);
    const client = this.#requireClient();
    try {
      await client.rpc(AGENT_SESSION_METHOD, encodeAgentSessionReport(report));
    } catch (error) {
      logger.error("Agent session report failed", {
        event: "agent_session:report_failed",
        request_id: report.requestId,
        workspace_id: report.workspaceId,
        computer_id: report.computerId,
        agent_id: report.agentId,
        provider: report.provider,
        error_code: diagnosticErrorCode(error),
        error_message: refusalText(error).slice(0, 200),
        outcome: "failed",
      });
      throw error;
    }
  }

  async #sendReady(
    client: CentrifugeWorkspaceClient,
    request: DaemonRuntimeReadyRequest,
  ): Promise<void> {
    await client.rpc(DAEMON_RUNTIME_READY_METHOD, encodeDaemonRuntimeReadyRequest(request));
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
      await this.#sendReady(client, request);
    } catch (error) {
      if (!recovering()) return;
      // Doubles per failed attempt so an outage is not hammered once a second per daemon.
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
        // Which step of the server's ready the failure came from, when it said so. Named here so
        // the failing machine's own log explains itself instead of requiring server logs.
        ...(stage ? { server_stage: stage } : {}),
        retry_delay_ms: delayMs,
        attempt: this.#readyRetryAttempts,
        failing_for_ms: Date.now() - this.#readyFailingSinceMs,
      };
      // Retrying forever at WARN hid a 13-hour outage on 2026-09-18: the connection stayed up, so
      // nothing looked wrong, while no Agent on the machine could be reached.
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
    this.#dispatchReadyPublications();
    const firstReady = this.#firstReady;
    if (!firstReady) {
      this.#reconnect.current?.();
      return;
    }
    // The runtime's own start reports what a reconnect would; this is not a reconnect.
    this.#firstReady = undefined;
    logger.info("Daemon ready completed", {
      event: "daemon_ready:completed",
      ...scope,
      running_agent_count: request.runningAgentIds.length,
      outcome: "ok",
    });
    firstReady.resolve();
  }

  /** Stops the retry under way. The failure count is kept: a reconnect continues it, so a
   * connection that keeps dropping still backs off and escalates. */
  #cancelReadyRecovery(): void {
    if (this.#readyRetryTimer !== undefined) this.timing.cancel(this.#readyRetryTimer);
    this.#readyRetryTimer = undefined;
    this.#readyRecoveryClient = undefined;
  }

  #dispatchReadyPublications(): void {
    const held = this.#readyPublications?.take();
    this.#readyPublications = undefined;
    if (!held) return;
    if (held.dropped > 0)
      logger.warning("Delivery notices held during ready were dropped; the cloud resends them", {
        event: "daemon_ready:notices_dropped",
        dropped: held.dropped,
        held_cap: HELD_NOTICE_CAP,
      });
    for (const dispatch of held.items) dispatch();
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
    if (this.#statusRefreshTimer) clearInterval(this.#statusRefreshTimer);
    this.#statusRefreshTimer = undefined;
    if (this.#computerStatusRefreshTimer !== undefined) {
      if (this.timing.cancelRepeating)
        this.timing.cancelRepeating(this.#computerStatusRefreshTimer);
      else clearInterval(this.#computerStatusRefreshTimer as ReturnType<typeof setInterval>);
      this.#computerStatusRefreshTimer = undefined;
    }
    await this.#statusRpcQueue;
    this.#client = undefined;
    this.#connected = false;
    this.#hasConnected = false;
    for (const slot of [
      this.#agentStart,
      this.#agentStop,
      this.#agentActivityProbe,
      this.#agentInboxPurge,
      this.#agentWorkspaceReset,
      this.#agentMessage,
      this.#reminderSync,
      this.#appConfigSync,
      this.#appRegistrationNotice,
      this.#agentMigrationLease,
      this.#agentMigrationCancel,
      this.#reconnect,
      this.#connectionRefused,
    ])
      slot.clear();
    this.#readyPublications = undefined;
    this.#readyRequestFactory = undefined;
    for (const collection of [
      this.#pendingActivity,
      this.#supersededActivityLaunches,
      this.#latestStatuses,
      this.#restartRequestIds,
      this.#upgradeRequestIds,
      this.#reportedUpgradeRequestIds,
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
