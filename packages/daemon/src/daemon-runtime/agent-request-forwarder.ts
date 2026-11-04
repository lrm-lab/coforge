import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
  AgentAppRequest,
  AgentTaskConversationRequest,
  AgentArtifactRequest,
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
import type {
  AgentMessageRecord,
  ChannelCommand,
  WeeklyReportCommand,
  WeeklyReportResponse,
  WorkspaceInfoRequest,
  WorkspaceInfoResponse,
} from "@lrm/coforge-sdk/internal";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { OpenVikingAgentProxyCommand } from "#src/openviking-read-proxy";
import type { AgentContexts } from "./agent-contexts";
import { elideForAgent } from "./context-elision";

import { settleForwardedTaskRead } from "./agent-history-read";
import { actionStampingAuthorizedAgent } from "./notice-action-clocks";
import {
  NOT_CONNECTED,
  transportCall,
  type ForwardingTransport,
} from "./agent-request-forwarder-transport";
import type { AgentMessageAttentionIndex } from "./agent-message-attention-index";

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
    | "appConfigGet"
    | "appConfigUpdate"
    | "agentApp"
    | "agentArtifact"
    | "agentTaskConversation"
    | "agentMemoryDisposition"
    | "agentOpenviking"
    | "threadList"
    | "labelList"
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
  connection: Readonly<{ workspaceId: string }>;
  /** Context ledger used by message and task reads to avoid repeating sender introductions. */
  contexts?: Pick<AgentContexts, "ledger">;
  /** The Agent a local context was issued to, once the runtime is running and the Agent API key
   * is well formed; otherwise throws that precondition's `AgentPreflightError`. */
  authorizedAgent(context: string, agentApiKey: string | undefined): string;
  /** Records one forwarded read's consumption scope in the message attention index: a task read
   * is the only forwarded read whose cursor the daemon keeps — deliveries replay it otherwise. */
  recordForwardedRead?: (
    agentId: string,
    query: Record<string, string> | undefined,
    result: unknown,
  ) => void;
}>;


/**
 * The Agent's local requests that the daemon only authorizes and forwards over the Agent HTTPS
 * transport, keeping no state of its own: Workspace and user info, GitHub credentials, the
 * Manual, profile, OpenViking reads, mention recovery, channels, action cards, weekly reports, and
 * attachments. Each keeps its own order of checks and refusal wording.
 */
/** The runtime's forwarded-request surface: its ports assembled where their wiring lives, so
 * `runtime.ts` holds a call, not the construction. `transport` is read per request — a restart
 * replaces it. */
export function assembleAgentRequests(input: {
  transport(): AgentRequestForwarderPorts["transport"];
  connection: AgentRequestForwarderPorts["connection"];
  contexts?: AgentRequestForwarderPorts["contexts"];
  authorizedAgent: AgentRequestForwarderPorts["authorizedAgent"];
  /** The attention index a forwarded task read's consumption settles into. */
  attention: AgentMessageAttentionIndex;
}): AgentRequestForwarder {
  return new AgentRequestForwarder({
    get transport() {
      return input.transport();
    },
    connection: input.connection,
    contexts: input.contexts,
    // Every forwarded request authorizes through here, so it stamps the Agent's action clock
    // too: a working Agent is never judged frozen (task #318).
    authorizedAgent: actionStampingAuthorizedAgent(input.authorizedAgent, input.attention.noticeActionClocks),
    recordForwardedRead: (agentId, query, result) =>
      settleForwardedTaskRead(input.attention, agentId, query, result),
  });
}

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
    if (request.route !== "read" || !response.ok) return response;
    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { messages?: unknown }).messages)
    )
      return response;
    const scope = (body as { consumptionScope?: { agentId: string; target: string } })
      .consumptionScope;
    if (scope?.agentId === agentId && scope.target)
      this.#ports.recordForwardedRead?.(agentId, request.query, body);
    const messages = (body as { messages: unknown[] }).messages;
    const elided = elideForAgent(
      this.#ports.contexts,
      agentId,
      messages as AgentMessageRecord[],
      "read",
    );
    if (elided === messages) return response;
    const next = { ...(body as Record<string, unknown>), messages: elided };
    // The upstream response is fetch's already-decoded body: `content-encoding` still names the
    // wire compression and `content-length` the old byte count, neither of which describes the
    // rewritten JSON. Only the media type survives.
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    const rewritten = new Response(JSON.stringify(next), {
      status: response.status,
      statusText: response.statusText,
      headers,
    }) as Response & { messages?: unknown };
    // `guardDelivery` reads this non-serialized field to release claims if the local client
    // disconnects before consuming the rewritten response body.
    rewritten.messages = elided;
    return rewritten;
  }

  async agentArtifact(
    context: string,
    request: AgentArtifactRequest,
    agentApiKey: string,
  ): Promise<Response> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentArtifact", NOT_CONNECTED)(request, agentApiKey);
  }

  async agentMemoryDisposition(
    context: string,
    request: unknown,
    agentApiKey: string,
  ): Promise<unknown> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentMemoryDisposition", NOT_CONNECTED)(request, agentApiKey);
  }

  async agentOpenviking(
    context: string,
    command: OpenVikingAgentProxyCommand,
    agentApiKey: string,
  ): Promise<unknown> {
    this.#ports.authorizedAgent(context, agentApiKey);
    return this.#transportCall("agentOpenviking", NOT_CONNECTED)(command, agentApiKey);
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

  /** Forwards Collect Run pack submit over Agent HTTPS (return path). */
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
