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
  AgentTaskConversationRequest,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingRequest,
  AgentInboxListResponse,
  AgentInboxRequest,
  AgentThreadListResponse,
  AgentMentionPendingResponse,
  AgentMentionDeliveryRequest,
  AgentMentionDeliveryResponse,
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
import type { OpenVikingAgentProxyCommand } from "./openviking-read-proxy";

/** The runtime handlers a local Agent proxy dispatches to; every member but `agentMessage` is
 * optional so a daemon build can light routes up incrementally (a missing handler is a 404). */
export type AgentProxyRuntime = {
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
  /** `coforge version`'s local-only query: answered entirely by the live Daemon, never
   * forwarded to Web/backend. */
  version?(
    context: string,
    request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentVersionResponse>;
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
  /** `coforge app list|token`: forwarded as it is, the cloud's response answered as it came. */
  agentApp?(context: string, request: AgentAppRequest, agentApiKey: string): Promise<Response>;
  /** `coforge task view|read|reply|follow|unfollow|list --following`: forwarded as it is, the
   * cloud's response answered as it came. */
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
  agentMemoryDisposition?(context: string, request: unknown, agentApiKey: string): Promise<unknown>;
  agentOpenviking?(
    context: string,
    request: OpenVikingAgentProxyCommand,
    agentApiKey: string,
  ): Promise<unknown>;
  /** Workspace-launch fence for the token-bound Agent. Absent or a non-OV fence fail-closes. */
  memoryFence?(agentId: string): string | undefined;
  issueAgentContext?: (agentId: string, context?: string) => string;
};
