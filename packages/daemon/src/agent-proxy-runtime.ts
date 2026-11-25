import type { TeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import type {
  ChannelCommand,
  LocalAgentMessageRequest,
  LocalInboxRequest,
  LocalReminderRequest,
  TaskCommand,
  WorkspaceInfoRequest,
  WorkspaceInfoResponse,
  WeeklyReportCommand,
} from "@lrm/coforge-sdk/internal";
import type {
  AgentActionPrepareRequest,
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
  AgentActionPrepareResponse,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentVersionResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
  GitHubCommitTrailersRequest,
  GitHubCommitTrailersResponse,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
  AgentAppRequest,
  AgentArtifactRequest,
  AgentTaskConversationRequest,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingRequest,
  AgentInboxListResponse,
  AgentInboxReadRequest,
  AgentInboxReadResponse,
  AgentInboxRequest,
  AgentLabelListResponse,
  AgentLabelWriteRequest,
  AgentThreadListResponse,
  AgentMentionPendingResponse,
  AgentMentionDeliveryRequest,
  AgentMentionDeliveryResponse,
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
  AgentProcListResponse,
  AgentProcLogsRequest,
  AgentProcLogsResponse,
  AgentProcStartRequest,
  AgentProcStartResponse,
  AgentProcStopRequest,
  AgentProcStopResponse,
} from "@lrm/coforge-sdk/agent";
import type {
  WeeklyReportCollectCommand,
  WeeklyReportCollectFailRunningCommand,
  WeeklyReportCollectResult,
} from "#src/connection/weekly-report-collect";
import type {
  WeeklyReportKeyPointsCommand,
  WeeklyReportKeyPointsResult,
} from "#src/connection/weekly-report-key-points";
import type {
  WeeklyReportMemoryCommand,
  WeeklyReportMemoryResult,
} from "#src/connection/weekly-report-memory";
import type {
  AgentArtifactDownloadRequest,
  AgentArtifactUploadRequest,
} from "#src/connection/agent-forwarded-routes";
import type { LocalMemoryCommand, LocalMemoryResult } from "@lrm/coforge-sdk/agent";
import type { AgentStateDb } from "#src/persistence/agent-state-db";
export type AgentProxyRuntime = {
  agentMemory?(
    context: string,
    request: LocalMemoryCommand,
    agentApiKey: string,
  ): Promise<LocalMemoryResult>;
  agentContext?(
    context: string,
    request: AgentContextSearchRequest | AgentContextReadRequest,
    agentApiKey: string,
  ): Promise<AgentContextQueryResponse>;
  procList?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentProcListResponse>;
  procStart?(
    context: string,
    request: AgentProcStartRequest,
    agentApiKey: string,
  ): Promise<AgentProcStartResponse>;
  procLogs?(
    context: string,
    request: AgentProcLogsRequest,
    agentApiKey: string,
  ): Promise<AgentProcLogsResponse>;
  procStop?(
    context: string,
    request: AgentProcStopRequest,
    agentApiKey: string,
  ): Promise<AgentProcStopResponse>;
  agentMessage(
    context: string,
    request: LocalAgentMessageRequest,
    agentApiKey: string,
  ): Promise<unknown>;
  agentAttachment?(context: string, attachmentId: string, agentApiKey: string): Promise<Response>;
  agentAttachmentUpload?(context: string, request: Request, agentApiKey: string): Promise<Response>;
  agentAttachmentUploadSessionCreate?(
    context: string,
    body: unknown,
    agentApiKey: string,
  ): Promise<Response>;
  agentAttachmentUploadSessionComplete?(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response>;
  agentAttachmentUploadSessionCancel?(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response>;
  agentAttachmentUploadSessionGet?(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response>;
  attachmentComments?(
    context: string,
    request: AgentAttachmentCommentsRequest,
    agentApiKey: string,
  ): Promise<AgentAttachmentCommentsResponse>;
  inbox?(context: string, request: LocalInboxRequest): Promise<unknown>;
  reminder?(context: string, request: LocalReminderRequest, agentApiKey: string): Promise<unknown>;
  agentTask?(context: string, request: TaskCommand, agentApiKey: string): Promise<unknown>;
  agentChannel?(context: string, request: ChannelCommand, agentApiKey: string): Promise<unknown>;
  agentActionPrepare?(
    context: string,
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse>;
  workspaceInfo?(
    context: string,
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse>;
  manualGet?(
    context: string,
    request: AgentManualGetRequest,
    agentApiKey: string,
  ): Promise<AgentManualGetResponse>;
  manualSearch?(
    context: string,
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse>;
  version?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse>;
  computerUpdateNotice?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<{
    ok: true;
    notice: string | null;
  }>;
  userInfo?(
    context: string,
    request: AgentUserInfoRequest,
    agentApiKey: string,
  ): Promise<AgentUserInfoResponse>;
  profileShow?(
    context: string,
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse>;
  profileUpdate?(
    context: string,
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse>;
  appConfigGet?(
    context: string,
    request: AgentAppConfigGetRequest,
    agentApiKey: string,
  ): Promise<AgentAppConfigResponse>;
  appConfigUpdate?(
    context: string,
    request: AgentAppConfigUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentAppConfigResponse>;
  agentApp?(context: string, request: AgentAppRequest, agentApiKey: string): Promise<Response>;
  agentTeamMemory?(
    context: string,
    request: TeamMemoryCommand,
    agentApiKey: string,
  ): Promise<Response>;
  agentArtifact?(
    context: string,
    request: AgentArtifactRequest,
    agentApiKey: string,
  ): Promise<Response>;
  agentArtifactUpload?(
    context: string,
    request: AgentArtifactUploadRequest,
    agentApiKey: string,
  ): Promise<Response>;
  agentArtifactDownload?(
    context: string,
    request: AgentArtifactDownloadRequest,
    agentApiKey: string,
  ): Promise<Response>;
  agentTaskConversation?(
    context: string,
    request: AgentTaskConversationRequest,
    agentApiKey: string,
  ): Promise<Response>;
  inboxList?(
    context: string,
    request: AgentInboxRequest,
    agentApiKey: string,
  ): Promise<AgentInboxListResponse>;
  threadList?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentThreadListResponse>;
  labelList?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentLabelListResponse>;
  agentLabel?(
    context: string,
    request: AgentLabelWriteRequest,
    agentApiKey: string,
  ): Promise<Response>;
  mentionPending?(
    context: string,
    request: AgentMentionPendingRequest,
    agentApiKey: string,
  ): Promise<AgentMentionPendingResponse>;
  mentionExecute?(
    context: string,
    request: AgentMentionExecuteRequest,
    agentApiKey: string,
  ): Promise<AgentMentionExecuteResponse>;
  mentionDelivery?(
    context: string,
    request: AgentMentionDeliveryRequest,
    agentApiKey: string,
  ): Promise<AgentMentionDeliveryResponse>;
  githubCredential?(
    context: string,
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse>;
  githubCommitTrailers?(
    context: string,
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse>;
  agentWeeklyReport?(
    context: string,
    request: WeeklyReportCommand,
    agentApiKey: string,
  ): Promise<unknown>;
  agentWeeklyReportCollect?(
    context: string,
    request: WeeklyReportCollectCommand | WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportCollectResult>;
  agentWeeklyReportKeyPoints?(
    context: string,
    request: WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportKeyPointsResult>;
  agentWeeklyReportMemory?(
    context: string,
    request: WeeklyReportMemoryCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportMemoryResult>;
  issueAgentContext?: (agentId: string, context?: string) => string;
  isAgentSessionRunning?: (agentId: string) => boolean;
  collab?: AgentProxyCollabHooks;
};

export type AgentProxyCollabHooks = {
  authorize(context: string, agentApiKey: string | undefined): string;
  stateDirectory(): string;
  stateDb?(agentId: string): AgentStateDb | undefined;
  reportsCompaction(agentId: string): boolean;
  canonicalizeTarget(context: string, target: string, agentApiKey: string): Promise<string>;
  readMessagesForInbox(
    context: string,
    request: AgentInboxReadRequest,
    agentApiKey: string,
  ): Promise<AgentInboxReadResponse>;
  settleDismissedTargets(
    context: string,
    targets: readonly string[],
    agentApiKey: string,
    requestedTarget?: string,
  ): Promise<void>;
};
