import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type {
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
  GitHubCommitTrailersRequest,
  GitHubCommitTrailersResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
  AgentInboxListResponse,
  AgentInboxRequest,
  AgentLabelListResponse,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentMentionDeliveryRequest,
  AgentMentionDeliveryResponse,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingRequest,
  AgentMentionPendingResponse,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentThreadListResponse,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
} from "@lrm/coforge-sdk/agent";
import type { AgentMessageHttpClient } from "./agent-http-clients";
import type { AgentHttpInput } from "./agent-http-wire";

/** What one forwarded Agent envelope request needs from the connection that owns it. */
export type AgentEnvelopePorts = {
  /** Refuses when the daemon cannot make the call: not connected, no endpoint, no route client. */
  requireClient(label: string, client: unknown): void;
  endpoint(what: string, path: string): string;
  keys(agentApiKey: string): { agentApiKey: string; daemonApiKey: string };
  client: AgentMessageHttpClient;
};

export function githubCredential(
  ports: AgentEnvelopePorts,
  request: GitHubCredentialRequest,
  agentApiKey: string,
): Promise<GitHubCredentialResponse> {
  return agentEnvelopeGet(
    ports,
    "GitHub credential",
    "GitHub credential",
    ports.client.requestGitHubCredential,
    agentApiRoutes.cloud.githubCredentials.path,
    request,
    agentApiKey,
  );
}

export function githubCommitTrailers(
  ports: AgentEnvelopePorts,
  request: GitHubCommitTrailersRequest,
  agentApiKey: string,
): Promise<GitHubCommitTrailersResponse> {
  return agentEnvelopeGet(
    ports,
    "GitHub commit trailers",
    "GitHub commit trailers",
    ports.client.requestGitHubCommitTrailers,
    agentApiRoutes.cloud.githubCommitTrailers.path,
    request,
    agentApiKey,
  );
}

/** One GET through a route's HTTP client with the Agent's keys. */
function agentEnvelopeGet<I, O>(
  ports: AgentEnvelopePorts,
  label: string,
  endpoint: string,
  client: ((input: AgentHttpInput<I>) => Promise<O>) | undefined,
  path: string,
  request: I,
  agentApiKey: string,
): Promise<O> {
  ports.requireClient(label, client);
  return client!({
    url: ports.endpoint(endpoint, path),
    ...ports.keys(agentApiKey),
    request,
  });
}

export function manualGet(
  ports: AgentEnvelopePorts,
  request: AgentManualGetRequest,
  agentApiKey: string,
): Promise<AgentManualGetResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent Manual",
    "Agent manual get",
    ports.client.requestManualGet,
    agentApiRoutes.cloud.manual.get.path,
    request,
    agentApiKey,
  );
}

export function manualSearch(
  ports: AgentEnvelopePorts,
  request: AgentManualSearchRequest,
  agentApiKey: string,
): Promise<AgentManualSearchResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent Manual",
    "Agent manual search",
    ports.client.requestManualSearch,
    agentApiRoutes.cloud.manual.search.path,
    request,
    agentApiKey,
  );
}

export function userInfo(
  ports: AgentEnvelopePorts,
  request: AgentUserInfoRequest,
  agentApiKey: string,
): Promise<AgentUserInfoResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent user info",
    "Agent user info",
    ports.client.requestUserInfo,
    agentApiRoutes.cloud.users.path(request.name),
    request,
    agentApiKey,
  );
}

export function profileShow(
  ports: AgentEnvelopePorts,
  request: AgentProfileShowRequest,
  agentApiKey: string,
): Promise<AgentProfileShowResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent profile",
    "Agent profile show",
    ports.client.requestProfileShow,
    agentApiRoutes.cloud.profile.get.path,
    request,
    agentApiKey,
  );
}

export function profileUpdate(
  ports: AgentEnvelopePorts,
  request: AgentProfileUpdateRequest,
  agentApiKey: string,
): Promise<AgentProfileUpdateResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent profile",
    "Agent profile update",
    ports.client.requestProfileUpdate,
    agentApiRoutes.cloud.profile.update.path,
    request,
    agentApiKey,
  );
}

export function appConfigGet(
  ports: AgentEnvelopePorts,
  request: AgentAppConfigGetRequest,
  agentApiKey: string,
): Promise<AgentAppConfigResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent app config",
    "Agent app config get",
    ports.client.requestAppConfigGet,
    agentApiRoutes.cloud.appConfig.get.path(request.appId),
    request,
    agentApiKey,
  );
}

export function appConfigUpdate(
  ports: AgentEnvelopePorts,
  request: AgentAppConfigUpdateRequest,
  agentApiKey: string,
): Promise<AgentAppConfigResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent app config",
    "Agent app config update",
    ports.client.requestAppConfigUpdate,
    agentApiRoutes.cloud.appConfig.update.path(request.appId),
    request,
    agentApiKey,
  );
}

export function inboxList(
  ports: AgentEnvelopePorts,
  request: AgentInboxRequest,
  agentApiKey: string,
): Promise<AgentInboxListResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent inbox list",
    "Agent inbox list",
    ports.client.requestInboxList,
    agentApiRoutes.cloud.inboxList.path,
    request,
    agentApiKey,
  );
}

export function threadList(
  ports: AgentEnvelopePorts,
  agentApiKey: string,
): Promise<AgentThreadListResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent thread list",
    "Agent thread list",
    ports.client.requestThreadList,
    agentApiRoutes.cloud.threadList.path,
    {},
    agentApiKey,
  );
}

/** `coforge label list`: the Workspace's labels. */
export function labelList(
  ports: AgentEnvelopePorts,
  agentApiKey: string,
): Promise<AgentLabelListResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent label list",
    "Agent label list",
    ports.client.requestLabelList,
    agentApiRoutes.cloud.labels.path,
    {},
    agentApiKey,
  );
}

export function mentionPending(
  ports: AgentEnvelopePorts,
  request: AgentMentionPendingRequest,
  agentApiKey: string,
): Promise<AgentMentionPendingResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent mention actions",
    "Agent mention pending",
    ports.client.requestMentionPending,
    agentApiRoutes.cloud.mentionActions.pending.path,
    request,
    agentApiKey,
  );
}

export function mentionExecute(
  ports: AgentEnvelopePorts,
  request: AgentMentionExecuteRequest,
  agentApiKey: string,
): Promise<AgentMentionExecuteResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent mention actions",
    "Agent mention action",
    ports.client.requestMentionExecute,
    agentApiRoutes.cloud.mentionActions.execute.path,
    request,
    agentApiKey,
  );
}

export function attachmentComments(
  ports: AgentEnvelopePorts,
  request: AgentAttachmentCommentsRequest,
  agentApiKey: string,
): Promise<AgentAttachmentCommentsResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent attachment comments",
    "Agent attachment comments",
    ports.client.requestAttachmentComments,
    agentApiRoutes.cloud.attachmentComments.path(request.attachmentId),
    request,
    agentApiKey,
  );
}

export function mentionDelivery(
  ports: AgentEnvelopePorts,
  request: AgentMentionDeliveryRequest,
  agentApiKey: string,
): Promise<AgentMentionDeliveryResponse> {
  return agentEnvelopeGet(
    ports,
    "Agent mention delivery",
    "Agent mention delivery",
    ports.client.requestMentionDelivery,
    agentApiRoutes.cloud.mentionDeliveries.path(request.messageId),
    request,
    agentApiKey,
  );
}
