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

type ForwardingTransport = AgentRequestForwarderPorts["transport"];

/** The refusal of a forwarded request whose transport is not connected. */
const NOT_CONNECTED = "daemon connection is not connected";

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

  /**
   * The current transport's `name` call, bound to that transport, or `refusal` when it cannot make
   * that call. The transport is read once, here: a restart replaces it between requests.
   */
  #transportCall<K extends keyof ForwardingTransport>(
    name: K,
    refusal: string,
  ): NonNullable<ForwardingTransport[K]> {
    const transport = this.#ports.transport;
    const call = transport[name];
    if (!call) throw new Error(refusal);
    return (call as (...args: never[]) => unknown).bind(transport) as NonNullable<
      ForwardingTransport[K]
    >;
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

  async agentOpenviking(
    context: string,
    command: OpenVikingAgentProxyCommand,
    agentApiKey: string,
  ): Promise<unknown> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentOpenviking", NOT_CONNECTED)(command, agentApiKey);
  }

  async mentionPending(
    context: string,
    _request: Record<string, never>,
    agentApiKey: string,
  ): Promise<AgentMentionPendingResponse> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall(
      "mentionPending",
      "Agent mention actions endpoint is not configured",
    )(agentApiKey);
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

  /** Dispatches a channel lifecycle/roster command to the cloud route `agentChannel` maps it
   * to, returning the JSON response body unchanged. */
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

  /** Forwards Collect Run pack submit over Agent HTTPS (ADR 0032 return path). */
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

  /** Forwards personal key-point extraction write-back over Agent HTTPS. */
  async agentWeeklyReportKeyPoints(
    context: string,
    command: import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<import("#src/connection/weekly-report-key-points").WeeklyReportKeyPointsResult> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentWeeklyReportKeyPoints", NOT_CONNECTED)(command, agentApiKey);
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
    return this.#transportCall("agentAttachment", NOT_CONNECTED)(attachmentId, agentApiKey);
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
