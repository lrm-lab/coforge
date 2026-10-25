import type {
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
  GitHubCommitTrailersRequest,
  GitHubCommitTrailersResponse,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
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
import type { WorkspaceInfoRequest, WorkspaceInfoResponse } from "@lrm/coforge-sdk/internal";

/** What a daemon connection forwards of an Agent's HTTP API to the cloud: each handler takes the
 * Agent's API key and answers what the route returned. */
export interface AgentApiConnectionClient {
  workspaceInfo?(
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse>;
  githubCredential?(
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse>;
  githubCommitTrailers?(
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse>;
  manualGet?(request: AgentManualGetRequest, agentApiKey: string): Promise<AgentManualGetResponse>;
  manualSearch?(
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse>;
  userInfo?(request: AgentUserInfoRequest, agentApiKey: string): Promise<AgentUserInfoResponse>;
  profileShow?(
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse>;
  profileUpdate?(
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse>;
  appConfigGet?(
    request: AgentAppConfigGetRequest,
    agentApiKey: string,
  ): Promise<AgentAppConfigResponse>;
  appConfigUpdate?(
    request: AgentAppConfigUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentAppConfigResponse>;
  threadList?(agentApiKey: string): Promise<AgentThreadListResponse>;
  inboxList?(request: AgentInboxRequest, agentApiKey: string): Promise<AgentInboxListResponse>;
  mentionPending?(
    request: AgentMentionPendingRequest,
    agentApiKey: string,
  ): Promise<AgentMentionPendingResponse>;
  mentionExecute?(
    request: AgentMentionExecuteRequest,
    agentApiKey: string,
  ): Promise<AgentMentionExecuteResponse>;
  mentionDelivery?(
    request: AgentMentionDeliveryRequest,
    agentApiKey: string,
  ): Promise<AgentMentionDeliveryResponse>;
  attachmentComments?(
    request: AgentAttachmentCommentsRequest,
    agentApiKey: string,
  ): Promise<AgentAttachmentCommentsResponse>;
}
