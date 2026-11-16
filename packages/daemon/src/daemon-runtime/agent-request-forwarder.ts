import type { TeamMemoryCommand } from "@lrm/coforge-sdk/agent";
import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
  AgentAppRequest,
  AgentTaskConversationRequest,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentMentionDeliveryRequest,
  AgentMentionDeliveryResponse,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
  AgentMentionPendingRequest,
  AgentAttachmentCommentsRequest,
  AgentAttachmentCommentsResponse,
  AgentInboxListResponse,
  AgentInboxRequest,
  AgentLabelListResponse,
  AgentLabelWriteRequest,
  AgentThreadListResponse,
  AgentMentionPendingResponse,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  GitHubCommitTrailersRequest,
  GitHubCommitTrailersResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
} from "@lrm/coforge-sdk/agent";
import type { AgentArtifactCall } from "#src/connection/agent-forwarded-routes";
import type {
  ChannelCommand,
  WeeklyReportCommand,
  WeeklyReportResponse,
  WorkspaceInfoRequest,
  WorkspaceInfoResponse,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { AgentContexts } from "./agent-contexts";
import { forwardedTaskReadResponse } from "./forwarded-task-read-response";
import { settleForwardedTaskRead } from "./agent-history-read";
import { actionStampingAuthorizedAgent } from "./notice-action-clocks";
import {
  NOT_CONNECTED,
  transportCall,
  type ForwardingTransport,
} from "./agent-request-forwarder-transport";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";
export type AgentRequestForwarderPorts = Readonly<{
  readonly transport: Pick<
    DaemonConnectionClient,
    | "agentTeamMemory"
    | "workspaceInfo"
    | "githubCredential"
    | "githubCommitTrailers"
    | "manualGet"
    | "manualSearch"
    | "userInfo"
    | "profileShow"
    | "profileUpdate"
    | "appConfigGet"
    | "appConfigUpdate"
    | "agentApp"
    | "agentArtifact"
    | "agentTaskConversation"
    | "threadList"
    | "labelList"
    | "agentLabel"
    | "inboxList"
    | "mentionPending"
    | "mentionExecute"
    | "mentionDelivery"
    | "agentChannel"
    | "agentActionPrepare"
    | "agentWeeklyReport"
    | "agentWeeklyReportCollect"
    | "agentWeeklyReportKeyPoints"
    | "agentWeeklyReportMemory"
    | "agentAttachment"
    | "attachmentComments"
    | "agentAttachmentUpload"
    | "agentAttachmentUploadSessionCreate"
    | "agentAttachmentUploadSessionComplete"
    | "agentAttachmentUploadSessionCancel"
    | "agentAttachmentUploadSessionGet"
  >;
  connection: Readonly<{
    workspaceId: string;
  }>;
  contexts?: Pick<AgentContexts, "ledger">;
  authorizedAgent(context: string, agentApiKey: string | undefined): string;
  recordForwardedRead?: (
    agentId: string,
    query: Record<string, string> | undefined,
    result: unknown,
  ) => void;
}>;
export function assembleAgentRequests(input: {
  transport(): AgentRequestForwarderPorts["transport"];
  connection: AgentRequestForwarderPorts["connection"];
  contexts?: AgentRequestForwarderPorts["contexts"];
  authorizedAgent: AgentRequestForwarderPorts["authorizedAgent"];
  attention: AgentMessageAttentionIndex;
}): AgentRequestForwarder {
  return new AgentRequestForwarder({
    get transport() {
      return input.transport();
    },
    connection: input.connection,
    contexts: input.contexts,
    authorizedAgent: actionStampingAuthorizedAgent(
      input.authorizedAgent,
      input.attention.noticeActionClocks,
    ),
    recordForwardedRead: (agentId, query, result) =>
      settleForwardedTaskRead(input.attention, agentId, query, result),
  });
}
export class AgentRequestForwarder {
  readonly #ports: AgentRequestForwarderPorts;
  constructor(ports: AgentRequestForwarderPorts) {
    this.#ports = ports;
  }
  #transportCall<K extends keyof ForwardingTransport>(
    name: K,
    refusal: string,
  ): NonNullable<ForwardingTransport[K]> {
    return transportCall(this.#ports, name, refusal);
  }
  async workspaceInfo(
    context: string,
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("workspaceInfo", NOT_CONNECTED)(request, agentApiKey);
  }
  async githubCredential(
    context: string,
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("githubCredential", "GitHub credential endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async githubCommitTrailers(
    context: string,
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall(
      "githubCommitTrailers",
      "GitHub commit trailers endpoint is not configured",
    )(request, agentApiKey);
  }
  async manualGet(
    context: string,
    request: AgentManualGetRequest,
    agentApiKey: string,
  ): Promise<AgentManualGetResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("manualGet", "Agent Manual endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async manualSearch(
    context: string,
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("manualSearch", "Agent Manual endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async userInfo(
    context: string,
    request: AgentUserInfoRequest,
    agentApiKey: string,
  ): Promise<AgentUserInfoResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("userInfo", "Agent user info endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async profileShow(
    context: string,
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("profileShow", "Agent profile endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async profileUpdate(
    context: string,
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("profileUpdate", "Agent profile endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async appConfigGet(
    context: string,
    request: AgentAppConfigGetRequest,
    agentApiKey: string,
  ): Promise<AgentAppConfigResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("appConfigGet", "Agent app config endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async appConfigUpdate(
    context: string,
    request: AgentAppConfigUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentAppConfigResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("appConfigUpdate", "Agent app config endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async agentApp(
    context: string,
    request: AgentAppRequest,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentApp", NOT_CONNECTED)(request, agentApiKey);
  }
  async agentTaskConversation(
    context: string,
    request: AgentTaskConversationRequest,
    agentApiKey: string,
  ): Promise<Response> {
    const agentId = this.#ports.authorizedAgent(context, agentApiKey);
    const response = await this.#transportCall("agentTaskConversation", NOT_CONNECTED)(
      request,
      agentApiKey,
    );
    return forwardedTaskReadResponse(
      {
        agentId,
        request,
        contexts: this.#ports.contexts,
        recordRead: this.#ports.recordForwardedRead,
      },
      response,
    );
  }
  async agentTeamMemory(
    context: string,
    request: TeamMemoryCommand,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentTeamMemory", NOT_CONNECTED)(request, agentApiKey);
  }
  async agentArtifact(
    context: string,
    request: AgentArtifactCall,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentArtifact", NOT_CONNECTED)(request, agentApiKey);
  }
  async inboxList(
    context: string,
    request: AgentInboxRequest,
    agentApiKey: string,
  ): Promise<AgentInboxListResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("inboxList", "Agent inbox endpoint is not configured")(
      request,
      agentApiKey,
    );
  }
  async threadList(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentThreadListResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall(
      "threadList",
      "Agent thread endpoint is not configured",
    )(agentApiKey);
  }
  async labelList(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentLabelListResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("labelList", "Agent labels endpoint is not configured")(agentApiKey);
  }
  async agentLabel(
    context: string,
    request: AgentLabelWriteRequest,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentLabel", NOT_CONNECTED)(request, agentApiKey);
  }
  async mentionPending(
    context: string,
    request: AgentMentionPendingRequest,
    agentApiKey: string,
  ): Promise<AgentMentionPendingResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall(
      "mentionPending",
      "Agent mention actions endpoint is not configured",
    )(request, agentApiKey);
  }
  async mentionExecute(
    context: string,
    request: AgentMentionExecuteRequest,
    agentApiKey: string,
  ): Promise<AgentMentionExecuteResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall(
      "mentionExecute",
      "Agent mention actions endpoint is not configured",
    )(request, agentApiKey);
  }
  async mentionDelivery(
    context: string,
    request: AgentMentionDeliveryRequest,
    agentApiKey: string,
  ): Promise<AgentMentionDeliveryResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall(
      "mentionDelivery",
      "Agent mention delivery endpoint is not configured",
    )(request, agentApiKey);
  }
  async agentChannel(
    context: string,
    command: ChannelCommand,
    agentApiKey: string,
  ): Promise<Record<string, unknown>> {
    const agentId = this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentChannel", NOT_CONNECTED)(
      {
        ...command,
        workspaceId: this.#ports.connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
  }
  async agentActionPrepare(
    context: string,
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentActionPrepare", NOT_CONNECTED)(request, agentApiKey);
  }
  async agentWeeklyReport(
    context: string,
    command: WeeklyReportCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse> {
    const agentId = this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentWeeklyReport", NOT_CONNECTED)(
      {
        ...command,
        idempotencyKey: crypto.randomUUID(),
        workspaceId: this.#ports.connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
  }
  async agentWeeklyReportCollect(
    context: string,
    command:
      | import("#src/connection/weekly-report-collect").WeeklyReportCollectCommand
      | import("#src/connection/weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<import("#src/connection/weekly-report-collect").WeeklyReportCollectResult> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentWeeklyReportCollect", NOT_CONNECTED)(command, agentApiKey);
  }
  async agentWeeklyReportKeyPoints(
    context: string,
    command: import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsResult> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentWeeklyReportKeyPoints", NOT_CONNECTED)(command, agentApiKey);
  }
  async agentWeeklyReportMemory(
    context: string,
    command: import("#src/connection/weekly-report-memory").WeeklyReportMemoryCommand,
    agentApiKey: string,
  ): Promise<import("#src/connection/weekly-report-memory").WeeklyReportMemoryResult> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentWeeklyReportMemory)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentWeeklyReportMemory(command, agentApiKey);
  }
  async agentAttachment(
    context: string,
    attachmentId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentAttachment", NOT_CONNECTED)(attachmentId, agentApiKey);
  }
  async attachmentComments(
    context: string,
    request: AgentAttachmentCommentsRequest,
    agentApiKey: string,
  ): Promise<AgentAttachmentCommentsResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("attachmentComments", NOT_CONNECTED)(request, agentApiKey);
  }
  async agentAttachmentUpload(
    context: string,
    request: Request,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentAttachmentUpload", NOT_CONNECTED)(request, agentApiKey);
  }
  async agentAttachmentUploadSessionCreate(
    context: string,
    body: unknown,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentAttachmentUploadSessionCreate", NOT_CONNECTED)(
      body,
      agentApiKey,
    );
  }
  async agentAttachmentUploadSessionComplete(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentAttachmentUploadSessionComplete", NOT_CONNECTED)(
      uploadId,
      agentApiKey,
    );
  }
  async agentAttachmentUploadSessionCancel(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentAttachmentUploadSessionCancel", NOT_CONNECTED)(
      uploadId,
      agentApiKey,
    );
  }
  async agentAttachmentUploadSessionGet(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentAttachmentUploadSessionGet", NOT_CONNECTED)(
      uploadId,
      agentApiKey,
    );
  }
}
