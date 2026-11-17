import type { AgentMemoryRequest, AgentMemoryResult } from "@lrm/coforge-sdk/internal";
import type { TeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import type { AgentApiConnectionClient } from "./agent-api-connection-client";
import type { AgentArtifactCall } from "./agent-forwarded-routes";
import type { AgentContextViewUploadMetadata } from "./agent-context-view-upload";
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
  AgentTaskConversationRequest,
  AgentTaskIdleNudgeRequest,
  AgentTaskIdleNudgeResponse,
  AgentSendReconciliationResponse,
} from "@lrm/coforge-sdk/agent";
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
  AgentWorkspaceScanRequest,
  AgentWorkspaceScanResult,
  AgentWorkspaceFileReadRequest,
  AgentWorkspaceFileReadResult,
  AgentWorkspaceDeleteRequest,
  AgentWorkspaceDeleteResult,
  AgentContextViewRequest,
  AgentContextViewResult,
  AgentContextViewAvailability,
  ComputerFilePullRequest,
  ComputerFilePullResult,
  ComputerUpgradeResult,
  AgentCredentialRestored,
  AgentMentionDeliveryTransition,
  AgentMentionDeliveryTerminalError,
  RuntimeAuthStatusReport,
  MachineStatusReport,
  DaemonRuntimeShutdown,
  DaemonRuntimeReadyRequest,
  DaemonRuntimeCodeAgentsUpdateRequest,
  DaemonRuntimeUsageScanRequest,
  DaemonRuntimeUsageScanResponse,
  DaemonRuntimeResetCreditConsumeRequest,
  DaemonRuntimeResetCreditConsumeResponse,
  DaemonRuntimeProviderModelRefreshRequest,
  DaemonRuntimeProviderModelRefreshResponse,
  DaemonRuntimeCommandCodeEffortReadRequest,
  DaemonRuntimeCommandCodeEffortReadResponse,
  AgentActivity,
  AgentStatus,
  AgentStartIntent,
  AgentStopIntent,
  AgentStaleRuntimeStop,
  AgentConfigSync,
  AgentTurnInterruptIntent,
  AgentActivityProbe,
  AgentInboxPurge,
  AgentMessageDelivery,
  AgentMessageDeliveryAck,
  AgentMessageDeliveryRejection,
  AgentMessageRequest,
  AgentReminderOperationRequest,
  AgentReminderOperationResponse,
  ReminderDue,
  ReminderDueAckRequest,
  AppConfigSnapshotRequest,
  AppConfigSync,
  AgentServerFeatures,
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
  identity?: AgentLaunchIdentity;
};
export interface DaemonConnectionConfig {
  workspaceId: string;
  computerId: string;
  workerInstanceId?: string;
  startedAt?: number;
  serverHttpUrl?: string;
  requestRestart?(requestId: string): Promise<void>;
  requestUpgrade?(
    requestId: string,
    expectedVersion?: string,
    releaseChannel?: string,
  ): Promise<void>;
  signal?: AbortSignal;
}
export interface DaemonConnectionClient extends AgentApiConnectionClient {
  onAgentWorkspaceReset?(callback: (request: AgentWorkspaceResetRequest) => void): () => void;
  sendAgentControlResult?(result: AgentControlResult): Promise<void>;
  sendAgentTurnInterruptResult?(result: AgentTurnInterruptResult): Promise<void>;
  start(token: string, config: DaemonConnectionConfig): Promise<void>;
  ready(createRequest: () => DaemonRuntimeReadyRequest, signal?: AbortSignal): Promise<void>;
  updateCodeAgents?(request: DaemonRuntimeCodeAgentsUpdateRequest): Promise<void>;
  reportRuntimeAuthStatus?(report: RuntimeAuthStatusReport): Promise<void>;
  sendMachineDiskStatus?(report: MachineStatusReport): Promise<void>;
  sendMachineMemoryStatus?(report: MachineStatusReport): Promise<void>;
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
  onWorkspaceScan?(callback: (request: AgentWorkspaceScanRequest) => Promise<void>): () => void;
  sendWorkspaceScanResult?(result: AgentWorkspaceScanResult): Promise<void>;
  onWorkspaceFileRead?(
    callback: (request: AgentWorkspaceFileReadRequest) => Promise<void>,
  ): () => void;
  sendWorkspaceFileReadResult?(result: AgentWorkspaceFileReadResult): Promise<void>;
  onWorkspaceDelete?(callback: (request: AgentWorkspaceDeleteRequest) => Promise<void>): () => void;
  sendWorkspaceDeleteResult?(result: AgentWorkspaceDeleteResult): Promise<void>;
  onAgentMemory?(callback: (request: AgentMemoryRequest) => Promise<void>): () => void;
  sendAgentMemoryResult?(result: AgentMemoryResult): Promise<void>;
  onAgentContextView?(callback: (request: AgentContextViewRequest) => Promise<void>): () => void;
  postAgentContextViewResult?(
    result: AgentContextViewResult,
    agentApiKey?: string,
  ): Promise<AgentContextViewUploadMetadata | void>;
  onComputerFilePull?(callback: (request: ComputerFilePullRequest) => Promise<void>): () => void;
  sendComputerFilePullResult?(result: ComputerFilePullResult): Promise<void>;
  onUsageScan?(callback: (request: DaemonRuntimeUsageScanRequest) => Promise<void>): () => void;
  sendUsageScanResult?(response: DaemonRuntimeUsageScanResponse): Promise<void>;
  onResetCreditConsume?(
    callback: (request: DaemonRuntimeResetCreditConsumeRequest) => Promise<void>,
  ): () => void;
  sendResetCreditConsumeResult?(response: DaemonRuntimeResetCreditConsumeResponse): Promise<void>;
  onProviderModelRefresh?(
    callback: (request: DaemonRuntimeProviderModelRefreshRequest) => Promise<void>,
  ): () => void;
  sendProviderModelRefreshResult?(
    response: DaemonRuntimeProviderModelRefreshResponse,
  ): Promise<void>;
  onCommandCodeEffortRead?(
    callback: (request: DaemonRuntimeCommandCodeEffortReadRequest) => Promise<void>,
  ): () => void;
  sendCommandCodeEffortReadResult?(
    response: DaemonRuntimeCommandCodeEffortReadResponse,
  ): Promise<void>;
  sendUpgradeResult?(result: ComputerUpgradeResult): Promise<boolean>;
  sendShutdownNotice?(notice: DaemonRuntimeShutdown): Promise<void>;
  stop(): Promise<void>;
  connectFailure?(): string | undefined;
  heldPublicationCount?(): number;
  onReconnect?(callback: () => void): () => void;
  onLatestComputerVersion?(callback: (version: string) => void): () => void;
  agentControlAccepted?(): boolean;
  onConnectionRefused?(callback: (reason: DaemonConnectRejectionReason) => void): () => void;
  onAgentStart?(callback: (intent: AgentStartIntent) => void): () => void;
  onAgentStop?(callback: (intent: AgentStopIntent) => void): () => void;
  onAgentStaleRuntimeStop?(callback: (intent: AgentStaleRuntimeStop) => void): () => void;
  onAgentTurnInterrupt?(callback: (intent: AgentTurnInterruptIntent) => void): () => void;
  onAgentActivityProbe?(callback: (probe: AgentActivityProbe) => void): () => void;
  onAgentInboxPurge?(callback: (purge: AgentInboxPurge) => void): () => void;
  onAgentMessage?(callback: (message: AgentMessageDelivery) => void): () => void;
  onReminderDue?(callback: (due: ReminderDue) => void): () => void;
  onAppConfigSync?(callback: (sync: AppConfigSync) => void): () => void;
  onAgentServerFeatures?(callback: (features: AgentServerFeatures) => void): () => void;
  onAgentConfigSync?(callback: (sync: AgentConfigSync) => void): () => void;
  onAppRegistrationNotice?(callback: (notice: AppRegistrationNotice) => void): () => void;
  onAgentMigrationLease?(callback: (lease: ReceivedAgentMigrationLease) => void): () => void;
  onAgentMigrationCancel?(callback: (cancel: AgentMigrationCancel) => void): () => void;
  agentMigrationServer?(): AgentMigrationServer;
  requestAppConfigSnapshot?(request: AppConfigSnapshotRequest): Promise<AppConfigSync>;
  acknowledgeReminderDue?(request: ReminderDueAckRequest): Promise<boolean>;
  agentReminder?(
    request: AgentReminderOperationRequest,
    agentApiKey: string,
  ): Promise<AgentReminderOperationResponse>;
  sendAgentActivity?(activity: AgentActivity): void;
  sendAgentReplyIntent?(frame: AgentReplyIntent): void;
  sendAgentStatus?(status: AgentStatus): void;
  reportAgentSession?(report: AgentSessionReport): Promise<void>;
  sendSessionInvalidate?(message: AgentSessionInvalidate): void;
  sendAgentContextUsage?(message: AgentContextUsage): void;
  sendAgentServiceTier?(message: AgentServiceTier): void;
  sendAgentContextViewAvailability?(message: AgentContextViewAvailability): void;
  sendAgentDeliveryAck?(ack: AgentMessageDeliveryAck): Promise<void>;
  sendAgentDeliveryRejection?(rejection: AgentMessageDeliveryRejection): Promise<void>;
  sendAgentMentionDeliveryTransition?(report: AgentMentionDeliveryTransition): Promise<void>;
  sendAgentMentionDeliveryTerminalError?(report: AgentMentionDeliveryTerminalError): Promise<void>;
  sendAgentCredentialRestored?(report: AgentCredentialRestored): Promise<void>;
  agentMessage?(
    request: AgentMessageRequest,
    agentApiKey: string,
  ): Promise<AgentMessageTransportResponse>;
  reconcileAgentSend?(
    request: AgentSendReconciliationRequest,
    agentApiKey: string,
  ): Promise<AgentSendReconciliationResponse>;
  agentTask?(request: TaskRequest, agentApiKey: string): Promise<TaskResponse>;
  agentTaskIdleNudge?(
    request: AgentTaskIdleNudgeRequest,
    agentApiKey: string,
  ): Promise<AgentTaskIdleNudgeResponse | undefined>;
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
  agentAttachment?(attachmentId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUpload?(request: Request, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCreate?(body: unknown, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionComplete?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCancel?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionGet?(uploadId: string, agentApiKey: string): Promise<Response>;
  agentApp?(request: AgentAppRequest, agentApiKey: string): Promise<Response>;
  agentTeamMemory?(request: TeamMemoryCommand, agentApiKey: string): Promise<Response>;
  agentArtifact?(request: AgentArtifactCall, agentApiKey: string): Promise<Response>;
  agentTaskConversation?(
    request: AgentTaskConversationRequest,
    agentApiKey: string,
  ): Promise<Response>;
  requestAgentApiKey?(input: { agentId: string; workspaceId: string }): Promise<string>;
  requestAgentLaunchConfig?(input: {
    agentId: string;
    workspaceId: string;
    controlEpoch?: number;
    requestId?: string;
    launchId?: string;
  }): Promise<AgentLaunchConfig>;
  revokeAgentApiKey?(agentApiKey: string, scope?: "all"): Promise<void>;
}
export interface DaemonConnectionClientFactory {
  create(config: DaemonConnectionConfig): DaemonConnectionClient;
}
export type ReceivedAgentMigrationLease = AgentMigrationLease & {
  deadline: number;
};
