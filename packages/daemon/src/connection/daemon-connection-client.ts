import type { AgentApiConnectionClient } from "./agent-api-connection-client";
import type {
  RuntimeAuthIntent,
  RuntimeAuthLoginReport,
  RuntimeAuthLogoutReport,
} from "@lrm/coforge-sdk/internal";
import type { PiChatRequest, PiChatFrame } from "@lrm/coforge-sdk/internal/pi-chat-wire";
import type { AgentReplyIntent } from "@lrm/coforge-sdk/internal/reply-intent";
import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  AgentAppRequest,
  AgentSendReconciliationResponse,
} from "@lrm/coforge-sdk/agent";
import type { OpenVikingAgentProxyCommand } from "#src/openviking-read-proxy";
import type {
  DaemonConnectRejectionReason,
  AgentWorkspaceResetRequest,
  AgentControlResult,
  AgentTurnInterruptResult,
  AgentSessionReport,
  AgentSessionInvalidate,
  AgentContextUsage,
  AgentServiceTier,
  AgentSkillsListRequest,
  AgentSkillsListResult,
  AgentWorkspaceFilesListRequest,
  AgentWorkspaceFilesListResult,
  AgentWorkspaceFileReadRequest,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceDeleteRequest,
  AgentWorkspaceDeleteResult,
  ComputerUpgradeResult,
  AgentContextScanRequest,
  AgentContextScanResponse,
  AgentMentionDeliveryTransition,
  AgentMentionDeliveryTerminalError,
  RuntimeAuthStatusReport,
  DaemonRuntimeShutdown,
  DaemonRuntimeReadyRequest,
  DaemonRuntimeCodeAgentsUpdateRequest,
  DaemonRuntimeUsageScanRequest,
  DaemonRuntimeUsageScanResponse,
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse,
  AgentActivity,
  AgentStatus,
  AgentStartIntent,
  AgentStopIntent,
  AgentTurnInterruptIntent,
  AgentActivityProbe,
  AgentInboxPurge,
  AgentMessageDelivery,
  AgentMessageDeliveryAck,
  AgentMessageDeliveryRejection,
  AgentMessageRequest,
  AgentReminderOperationRequest,
  AgentReminderOperationResponse,
  ReminderFireRequest,
  ReminderFireResponse,
  ReminderSnapshotRequest,
  ReminderSync,
  AppConfigSnapshotRequest,
  AppConfigSync,
  AgentMigrationCancel,
  AgentMigrationLease,
  TaskRequest,
  TaskResponse,
  WeeklyReportRequest,
  WeeklyReportResponse,
} from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeProviderConfig } from "@lrm/coforge-anvil";
import type { AgentLaunchIdentity } from "#src/code-agent/agent-instructions";
import type { AppRegistrationNotice } from "@lrm/coforge-sdk/internal/app-registration-notice";
import type { AgentMigrationServer } from "#src/agent-migration/transfer-ports";
import type {
  AgentChannelRequest,
  AgentMessageTransportResponse,
  AgentSendReconciliationRequest,
} from "./agent-http-clients";

export type AgentLaunchConfig = {
  agentApiKey: string;
  providerConfig?: AgentRuntimeProviderConfig;
  envVars?: Record<string, string>;
  assignedSkillPacks?: string[];
  /** Server-authored Agent identity for the standing prompt; see `agent-instructions.ts`. Not
   * part of the shared SDK today because the whole launch-config contract lives only here. */
  identity?: AgentLaunchIdentity;
};

/** Configuration identifying the daemon's Workspace connection. */
export interface DaemonConnectionConfig {
  workspaceId: string;
  computerId: string;
  /** Server HTTP origin used only for Agent read/send RPCs. */
  serverHttpUrl?: string;
  /** Requests replacement of only this Workspace runtime. The supervisor supplies recovery evidence. */
  requestRestart?(requestId: string): Promise<void>;
  requestUpgrade?(requestId: string, expectedVersion?: string): Promise<void>;
  /** Aborting it gives up a `start` still waiting for its first connection; no effect after. */
  signal?: AbortSignal;
}

/** Provider-neutral client contract for the daemon's Workspace connection. */
export interface DaemonConnectionClient extends AgentApiConnectionClient {
  onAgentWorkspaceReset?(callback: (request: AgentWorkspaceResetRequest) => void): () => void;
  sendAgentControlResult?(result: AgentControlResult): Promise<void>;
  sendAgentTurnInterruptResult?(result: AgentTurnInterruptResult): Promise<void>;
  start(token: string, config: DaemonConnectionConfig): Promise<void>;
  /** Resolves once the cloud accepts the first ready, retrying like a reconnect ready until then.
   * Rejects only on `stop` or `signal` aborting. */
  ready(createRequest: () => DaemonRuntimeReadyRequest, signal?: AbortSignal): Promise<void>;
  updateCodeAgents?(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void>;
  reportRuntimeAuthStatus?(report: RuntimeAuthStatusReport): Promise<void>;
  reportRuntimeAuthLogin?(report: RuntimeAuthLoginReport): Promise<void>;
  reportRuntimeAuthLogout?(report: RuntimeAuthLogoutReport): Promise<void>;
  onRuntimeAuth?(callback: (intent: RuntimeAuthIntent) => void): () => void;
  onSkillsList?(callback: (request: AgentSkillsListRequest) => Promise<void>): () => void;
  onPiChatRequest?(callback: (request: PiChatRequest) => Promise<void>): () => void;
  sendPiChatFrame?(frame: PiChatFrame): Promise<void>;
  sendSkillsListResult?(result: AgentSkillsListResult): Promise<void>;
  onWorkspaceFilesList?(
    callback: (request: AgentWorkspaceFilesListRequest) => Promise<void>,
  ): () => void;
  sendWorkspaceFilesListResult?(result: AgentWorkspaceFilesListResult): Promise<void>;
  onWorkspaceFileRead?(
    callback: (request: AgentWorkspaceFileReadRequest) => Promise<void>,
  ): () => void;
  sendWorkspaceFileReadResult?(result: AgentWorkspaceFileReadResult): Promise<void>;
  onWorkspaceDelete?(callback: (request: AgentWorkspaceDeleteRequest) => Promise<void>): () => void;
  sendWorkspaceDeleteResult?(result: AgentWorkspaceDeleteResult): Promise<void>;
  onUsageScan?(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void;
  sendUsageScanResult?(response: DaemonRuntimeUsageScanResponse): Promise<void>;
  onProviderModelRefresh?(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void;
  sendProviderModelRefreshResult?(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<void>;
  onAgentContextScan?(callback: (request: AgentContextScanRequest) => Promise<void>): () => void;
  sendAgentContextScanResult?(response: AgentContextScanResponse): Promise<void>;
  sendUpgradeResult?(result: ComputerUpgradeResult): Promise<boolean>;
  sendShutdownNotice?(notice: DaemonRuntimeShutdown): Promise<void>;
  stop(): Promise<void>;
  /** Why the latest connect attempt failed, while the connection is not up. */
  connectFailure?(): string | undefined;
  onReconnect?(callback: () => void): () => void;
  /** The cloud refused an already-running connection for good; the connection no longer
   * reconnects. A refusal while `start` is connecting rejects `start` instead. */
  onConnectionRefused?(callback: (reason: DaemonConnectRejectionReason) => void): () => void;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentStop?(callback: (intent: AgentStopIntent) => void): () => void;
  onAgentTurnInterrupt?(callback: (intent: AgentTurnInterruptIntent) => void): () => void;
  onAgentActivityProbe?(callback: (probe: AgentActivityProbe) => void): () => void;
  onAgentInboxPurge?(callback: (purge: AgentInboxPurge) => void): () => void;
  onAgentMessage?(callback: (message: AgentMessageDelivery) => void): () => void;
  onReminderSync?(callback: (sync: ReminderSync) => void): () => void;
  onAppConfigSync?(callback: (sync: AppConfigSync) => void): () => void;
  onAppRegistrationNotice?(callback: (notice: AppRegistrationNotice) => void): () => void;
  onAgentMigrationLease?(callback: (lease: ReceivedAgentMigrationLease) => void): () => void;
  onAgentMigrationCancel?(callback: (cancel: AgentMigrationCancel) => void): () => void;
  agentMigrationServer?(): AgentMigrationServer;
  requestSnapshot?(request: ReminderSnapshotRequest): Promise<ReminderSync>;
  requestAppConfigSnapshot?(request: AppConfigSnapshotRequest): Promise<AppConfigSync>;
  fireReminder?(request: ReminderFireRequest): Promise<ReminderFireResponse>;
  agentReminder?(
    request: AgentReminderOperationRequest,
    agentApiKey: string,
  ): Promise<AgentReminderOperationResponse>;
  sendAgentActivity?(activity: AgentActivity): void;
  /** Best effort: dropped, never buffered, while disconnected. */
  sendAgentReplyIntent?(frame: AgentReplyIntent): void;
  sendAgentStatus?(status: AgentStatus): void;
  reportAgentSession?(report: AgentSessionReport): Promise<void>;
  /** Fire-and-forget: never blocks or fails a launch. Buffered latest-per-agent while
   * disconnected and flushed on reconnect, like `sendAgentActivity`. */
  sendSessionInvalidate?(message: AgentSessionInvalidate): void;
  /** Fire-and-forget: never blocks or fails a turn. Buffered latest-per-agent while
   * disconnected and flushed on reconnect, like `sendSessionInvalidate`. */
  sendAgentContextUsage?(message: AgentContextUsage): void;
  /** Fire-and-forget observation of the launch's service tier, buffered and flushed the same way
   * as `sendAgentContextUsage`. */
  sendAgentServiceTier?(message: AgentServiceTier): void;
  sendAgentDeliveryAck?(ack: AgentMessageDeliveryAck): Promise<void>;
  /** Rejects a delivery the daemon did not take custody of back to the server; never an ACK. */
  sendAgentDeliveryRejection?(rejection: AgentMessageDeliveryRejection): Promise<void>;
  /** Progress of a tracked @mention delivery; diagnostic only, never an ACK. */
  sendAgentMentionDeliveryTransition?(report: AgentMentionDeliveryTransition): Promise<void>;
  /** The final result of a tracked @mention delivery the daemon will not drain. */
  sendAgentMentionDeliveryTerminalError?(report: AgentMentionDeliveryTerminalError): Promise<void>;
  agentMessage?(
    request: AgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageTransportResponse>;
  /** Whether a send's idempotency key already committed (`reconcileOnly`); never sends. */
  reconcileAgentSend?(
    request: AgentSendReconciliationRequest,
    agentApiKey: string,
  ): Promise<AgentSendReconciliationResponse>;
  agentTask?(request: TaskRequest, agentApiKey: string): Promise<TaskResponse>;
  agentChannel?(
    request: AgentChannelRequest,
    agentApiKey: string,
  ): Promise<Record<string, unknown>>;
  agentActionPrepare?(
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse>;
  agentWeeklyReport?(
    request: WeeklyReportRequest,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse>;
  agentWeeklyReportCollect?(
    request:
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult>;
  agentWeeklyReportKeyPoints?(
    request: import("./weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult>;
  agentWeeklyReportMemory?(
    request: import("./weekly-report-memory").WeeklyReportMemoryCommand,
    agentApiKey: string,
  ): Promise<import("./weekly-report-memory").WeeklyReportMemoryResult>;
  agentMemoryDisposition?(request: unknown, agentApiKey: string): Promise<unknown>;
  agentOpenviking?(request: OpenVikingAgentProxyCommand, agentApiKey: string): Promise<unknown>;
  agentAttachment?(attachmentId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUpload?(request: Request, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCreate?(body: unknown, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionComplete?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCancel?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionGet?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentApp?(request: AgentAppRequest, agentApiKey: string): Promise<Response>;
  requestAgentApiKey?(input: { agentId: string; workspaceId: string }): Promise<string>;
  requestAgentLaunchConfig?(input: {
    agentId: string;
    workspaceId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  }): Promise<AgentLaunchConfig>;
  revokeAgentApiKey?(agentApiKey: string): Promise<void>;
}

/** Creates the Daemon connection client owned by the daemon. */
export interface DaemonConnectionClientFactory {
  create(config: DaemonConnectionConfig): DaemonConnectionClient;
}

/** A migration lease as it arrived: `deadline` is its expiry in this Computer's clock. */
export type ReceivedAgentMigrationLease = AgentMigrationLease & { deadline: number };
