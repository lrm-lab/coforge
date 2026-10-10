import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentMentionDeliveryRequest,
  AgentMentionDeliveryResponse,
  AgentMentionExecuteRequest,
  AgentMentionExecuteResponse,
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
import type {
  ChannelCommand,
  WeeklyReportCommand,
  WeeklyReportResponse,
  WorkspaceInfoRequest,
  WorkspaceInfoResponse,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection";
import type { OpenVikingAgentProxyCommand } from "#src/openviking-read-proxy";

export type AgentRequestForwarderPorts = Readonly<{
  /** The current transport; read at each request, since a restart replaces it. */
  readonly transport: Pick<
    DaemonConnectionClient,
    | "workspaceInfo"
    | "githubCredential"
    | "githubCommitTrailers"
    | "manualGet"
    | "manualSearch"
    | "userInfo"
    | "profileShow"
    | "profileUpdate"
    | "agentOpenviking"
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
    | "agentAttachmentUpload"
    | "agentAttachmentUploadSessionCreate"
    | "agentAttachmentUploadSessionComplete"
    | "agentAttachmentUploadSessionCancel"
    | "agentAttachmentUploadSessionGet"
  >;
  connection: Readonly<{ workspaceId: string }>;
  /** The Agent a local context was issued to, once the runtime is running and the Agent API key
   * is well formed; otherwise throws that precondition's `AgentPreflightError`. */
  authorizedAgent(context: string, agentApiKey: string | undefined): string;
}>;

/**
 * The Agent's local requests that the daemon only authorizes and forwards over the Agent HTTPS
 * transport, keeping no state of its own: Workspace and user info, GitHub credentials, the
 * Manual, profile, OpenViking reads, mention recovery, channels, action cards, weekly reports, and
 * attachments. Each keeps its own order of checks and refusal wording.
 */
export class AgentRequestForwarder {
  readonly #ports: AgentRequestForwarderPorts;

  constructor(ports: AgentRequestForwarderPorts) {
    this.#ports = ports;
  }

  async workspaceInfo(
    context: string,
    request: WorkspaceInfoRequest,
    agentApiKey: string,
  ): Promise<WorkspaceInfoResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.workspaceInfo) throw new Error("daemon connection is not connected");
    return this.#ports.transport.workspaceInfo(request, agentApiKey);
  }

  async githubCredential(
    context: string,
    request: GitHubCredentialRequest,
    agentApiKey: string,
  ): Promise<GitHubCredentialResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.githubCredential)
      throw new Error("GitHub credential endpoint is not configured");
    return this.#ports.transport.githubCredential(request, agentApiKey);
  }

  async githubCommitTrailers(
    context: string,
    request: GitHubCommitTrailersRequest,
    agentApiKey: string,
  ): Promise<GitHubCommitTrailersResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.githubCommitTrailers)
      throw new Error("GitHub commit trailers endpoint is not configured");
    return this.#ports.transport.githubCommitTrailers(request, agentApiKey);
  }

  async manualGet(
    context: string,
    request: AgentManualGetRequest,
    agentApiKey: string,
  ): Promise<AgentManualGetResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.manualGet)
      throw new Error("Agent Manual endpoint is not configured");
    return this.#ports.transport.manualGet(request, agentApiKey);
  }

  async manualSearch(
    context: string,
    request: AgentManualSearchRequest,
    agentApiKey: string,
  ): Promise<AgentManualSearchResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.manualSearch)
      throw new Error("Agent Manual endpoint is not configured");
    return this.#ports.transport.manualSearch(request, agentApiKey);
  }

  async userInfo(
    context: string,
    request: AgentUserInfoRequest,
    agentApiKey: string,
  ): Promise<AgentUserInfoResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.userInfo)
      throw new Error("Agent user info endpoint is not configured");
    return this.#ports.transport.userInfo(request, agentApiKey);
  }

  async profileShow(
    context: string,
    request: AgentProfileShowRequest,
    agentApiKey: string,
  ): Promise<AgentProfileShowResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.profileShow)
      throw new Error("Agent profile endpoint is not configured");
    return this.#ports.transport.profileShow(request, agentApiKey);
  }

  async profileUpdate(
    context: string,
    request: AgentProfileUpdateRequest,
    agentApiKey: string,
  ): Promise<AgentProfileUpdateResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.profileUpdate)
      throw new Error("Agent profile endpoint is not configured");
    return this.#ports.transport.profileUpdate(request, agentApiKey);
  }

  async agentOpenviking(
    context: string,
    command: OpenVikingAgentProxyCommand,
    agentApiKey: string,
  ): Promise<unknown> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentOpenviking)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentOpenviking(command, agentApiKey);
  }

  async mentionPending(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentMentionPendingResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.mentionPending)
      throw new Error("Agent mention actions endpoint is not configured");
    return this.#ports.transport.mentionPending(agentApiKey);
  }

  async mentionExecute(
    context: string,
    request: AgentMentionExecuteRequest,
    agentApiKey: string,
  ): Promise<AgentMentionExecuteResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.mentionExecute)
      throw new Error("Agent mention actions endpoint is not configured");
    return this.#ports.transport.mentionExecute(request, agentApiKey);
  }

  async mentionDelivery(
    context: string,
    request: AgentMentionDeliveryRequest,
    agentApiKey: string,
  ): Promise<AgentMentionDeliveryResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.mentionDelivery)
      throw new Error("Agent mention delivery endpoint is not configured");
    return this.#ports.transport.mentionDelivery(request, agentApiKey);
  }

  /** Dispatches a channel lifecycle/roster command to the cloud route `agentChannel` maps it
   * to, returning the JSON response body unchanged. */
  async agentChannel(
    context: string,
    command: ChannelCommand,
    agentApiKey: string,
  ): Promise<Record<string, unknown>> {
    const agentId = this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentChannel) throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentChannel(
      {
        ...command,
        workspaceId: this.#ports.connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
  }

  /**
   * Posts an Agent-prepared action card (`coforge action prepare`). Unlike `agentTask`, the wire
   * request carries no `workspaceId`/`agentId` — the HTTPS route derives the principal from the
   * authenticated Agent/daemon API key pair, exactly like an ordinary Agent message send.
   */
  async agentActionPrepare(
    context: string,
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentActionPrepare)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentActionPrepare(request, agentApiKey);
  }

  async agentWeeklyReport(
    context: string,
    command: WeeklyReportCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse> {
    const agentId = this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentWeeklyReport)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentWeeklyReport(
      {
        ...command,
        idempotencyKey: crypto.randomUUID(),
        workspaceId: this.#ports.connection.workspaceId,
        agentId,
      },
      agentApiKey,
    );
  }

  /** Forwards Collect Run pack submit over Agent HTTPS (ADR 0032 return path). */
  async agentWeeklyReportCollect(
    context: string,
    command:
      | import("#src/connection/weekly-report-collect").WeeklyReportCollectCommand
      | import("#src/connection/weekly-report-collect").WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<import("#src/connection/weekly-report-collect").WeeklyReportCollectResult> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentWeeklyReportCollect)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentWeeklyReportCollect(command, agentApiKey);
  }

  /** Forwards personal key-point extraction write-back over Agent HTTPS. */
  async agentWeeklyReportKeyPoints(
    context: string,
    command: import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsResult> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentWeeklyReportKeyPoints)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentWeeklyReportKeyPoints(command, agentApiKey);
  }

  /** Forwards weekly-report memory settlement write-back over Agent HTTPS. */
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
    if (!this.#ports.transport.agentAttachment)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentAttachment(attachmentId, agentApiKey);
  }

  async agentAttachmentUpload(
    context: string,
    request: Request,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentAttachmentUpload)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentAttachmentUpload(request, agentApiKey);
  }

  async agentAttachmentUploadSessionCreate(
    context: string,
    body: unknown,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentAttachmentUploadSessionCreate)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentAttachmentUploadSessionCreate(body, agentApiKey);
  }

  async agentAttachmentUploadSessionComplete(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentAttachmentUploadSessionComplete)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentAttachmentUploadSessionComplete(uploadId, agentApiKey);
  }

  async agentAttachmentUploadSessionCancel(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentAttachmentUploadSessionCancel)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentAttachmentUploadSessionCancel(uploadId, agentApiKey);
  }

  async agentAttachmentUploadSessionGet(
    context: string,
    uploadId: string,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    if (!this.#ports.transport.agentAttachmentUploadSessionGet)
      throw new Error("daemon connection is not connected");
    return this.#ports.transport.agentAttachmentUploadSessionGet(uploadId, agentApiKey);
  }
}
