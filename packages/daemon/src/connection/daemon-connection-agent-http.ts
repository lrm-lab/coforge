// The Agent HTTPS requests this daemon forwards: each one is a call to the cloud carrying the
// Agent's own key, and each is gated on the server's HTTP origin alone — never on the WebSocket,
// which is why a message keeps working through a reconnect (2026-11-16). Split out of
// `daemon-connection.ts` when the size ratchet stopped that file growing; the connection holds the
// credentials and the client gate behind the accessor below.
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type {
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  AgentAppConfigGetRequest,
  AgentAppConfigUpdateRequest,
  AgentAppRequest,
  AgentAttachmentCommentsRequest,
  AgentInboxListResponse,
  AgentInboxRequest,
  AgentLabelListResponse,
  AgentLabelWriteRequest,
  AgentMentionDeliveryRequest,
  AgentMentionExecuteRequest,
  AgentMentionPendingRequest,
  AgentProfileShowRequest,
  AgentProfileUpdateRequest,
  AgentTaskConversationRequest,
  AgentThreadListResponse,
  AgentUserInfoRequest,
  AgentManualGetRequest,
  AgentManualSearchRequest,
  GitHubCommitTrailersRequest,
  GitHubCredentialRequest,
} from "@lrm/coforge-sdk/agent";
import type { TaskRequest, TaskResponse } from "@lrm/coforge-sdk/internal";
import type { AgentLaunchConfig } from "./daemon-connection-client";
import type { OpenVikingAgentProxyCommand } from "../openviking-read-proxy";
import { forwardOpenVikingControl, forwardOpenVikingRead } from "../openviking-read-proxy";
import { serverEndpoint } from "./daemon-endpoints";
import { DaemonConnectionWorkspaceBindings } from "./daemon-connection-workspace-bindings";
import {
  appConfigGet,
  appConfigUpdate,
  attachmentComments,
  githubCommitTrailers,
  githubCredential,
  inboxList,
  labelList,
  manualGet,
  manualSearch,
  mentionDelivery,
  mentionExecute,
  mentionPending,
  profileShow,
  profileUpdate,
  threadList,
  userInfo,
} from "./agent-envelope-requests";
import {
  agentApp,
  agentArtifact,
  type AgentArtifactCall,
  agentLabel,
  agentAttachment,
  agentAttachmentUpload,
  agentAttachmentUploadSessionCancel,
  agentAttachmentUploadSessionComplete,
  agentAttachmentUploadSessionCreate,
  agentAttachmentUploadSessionGet,
  agentTaskConversation,
  type ForwardPorts,
} from "./agent-forwarded-routes";
import {
  weeklyReport,
  weeklyReportCollect,
  weeklyReportKeyPoints,
  weeklyReportMemory,
  type WeeklyReportCollectCommand,
  type WeeklyReportCollectFailRunningCommand,
  type WeeklyReportCollectResult,
  type WeeklyReportKeyPointsCommand,
  type WeeklyReportKeyPointsResult,
  type WeeklyReportMemoryCommand,
  type WeeklyReportMemoryResult,
} from "./agent-weekly-report";
import { taskIdleNudge, type AgentTaskIdleNudgeHttpClient } from "./agent-task-idle-nudge-client";
import type { AgentTaskIdleNudgeRequest, AgentTaskIdleNudgeResponse } from "@lrm/coforge-sdk/agent";
import {
  requestAgentApiKey,
  requestAgentLaunchConfig,
  revokeAgentApiKey,
  type AgentApiKeyEndpoint,
} from "./agent-api-key-requests";
import { channelEndpointFor, sendAgentJson } from "./agent-http-wire";
import type {
  AgentMessageHttpClient,
  AgentTaskHttpClient,
  AgentChannelHttpClient,
  AgentActionPrepareHttpClient,
  AgentWeeklyReportHttpClient,
  AgentChannelRequest,
} from "./agent-http-clients";
import type { WeeklyReportRequest, WeeklyReportResponse } from "@lrm/coforge-sdk/internal";

/** What the forwarded Agent HTTPS requests need from the connection that owns them. */
export type AgentHttpDeps = {
  /** The server's HTTPS origin; empty when nothing configured one. */
  serverHttpUrl(): string;
  /** The daemon's own API key, sent beside the Agent's. */
  token(): string;
  /** Refuses a request when no origin is configured. */
  assertServerHttp(): void;
  keys(agentApiKey: string): { agentApiKey: string; daemonApiKey: string };
  clients: {
    readonly message: AgentMessageHttpClient;
    readonly task: AgentTaskHttpClient;
    readonly channel: AgentChannelHttpClient;
    readonly actionPrepare: AgentActionPrepareHttpClient;
    readonly weeklyReport: AgentWeeklyReportHttpClient;
    readonly taskIdleNudge: AgentTaskIdleNudgeHttpClient;
  };
};

/** The Agent HTTPS surface of the daemon connection: reads, writes and forwarding, all of them
 * calls to the cloud with the Agent's key. */
export abstract class DaemonConnectionAgentHttp extends DaemonConnectionWorkspaceBindings {
  protected abstract get agentHttp(): AgentHttpDeps;

  async githubCredential(request: GitHubCredentialRequest, agentApiKey: string) {
    return githubCredential(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async githubCommitTrailers(request: GitHubCommitTrailersRequest, agentApiKey: string) {
    return githubCommitTrailers(
      this.agentPorts(this.agentHttp.clients.message),
      request,
      agentApiKey,
    );
  }

  async manualGet(request: AgentManualGetRequest, agentApiKey: string) {
    return manualGet(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async manualSearch(request: AgentManualSearchRequest, agentApiKey: string) {
    return manualSearch(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async userInfo(request: AgentUserInfoRequest, agentApiKey: string) {
    return userInfo(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async profileShow(request: AgentProfileShowRequest, agentApiKey: string) {
    return profileShow(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async profileUpdate(request: AgentProfileUpdateRequest, agentApiKey: string) {
    return profileUpdate(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async appConfigGet(request: AgentAppConfigGetRequest, agentApiKey: string) {
    return appConfigGet(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async appConfigUpdate(request: AgentAppConfigUpdateRequest, agentApiKey: string) {
    return appConfigUpdate(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  /** A forwarded Agent request needs the server's HTTPS origin and the HTTP client for its route;
   * the WebSocket is not one of its dependencies. */
  private requireAgentClient(label: string, client: unknown): void {
    if (!this.agentHttp.serverHttpUrl()) throw new Error(`${label} endpoint is not configured`);
    if (!client) throw new Error(`${label} HTTP client is unavailable`);
  }

  inboxList(request: AgentInboxRequest, agentApiKey: string): Promise<AgentInboxListResponse> {
    return inboxList(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  threadList(agentApiKey: string): Promise<AgentThreadListResponse> {
    return threadList(this.agentPorts(this.agentHttp.clients.message), agentApiKey);
  }

  /** `coforge label list`: the Workspace's labels, forwarded like the other envelope reads. */
  labelList(agentApiKey: string): Promise<AgentLabelListResponse> {
    return labelList(this.agentPorts(this.agentHttp.clients.message), agentApiKey);
  }

  mentionPending(request: AgentMentionPendingRequest, agentApiKey: string) {
    return mentionPending(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  async mentionExecute(request: AgentMentionExecuteRequest, agentApiKey: string) {
    return mentionExecute(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }

  attachmentComments(request: AgentAttachmentCommentsRequest, agentApiKey: string) {
    return attachmentComments(
      this.agentPorts(this.agentHttp.clients.message),
      request,
      agentApiKey,
    );
  }

  async mentionDelivery(request: AgentMentionDeliveryRequest, agentApiKey: string) {
    return mentionDelivery(this.agentPorts(this.agentHttp.clients.message), request, agentApiKey);
  }
  async agentMemoryDisposition(request: unknown, agentApiKey: string): Promise<unknown> {
    this.agentHttp.assertServerHttp();
    return sendAgentJson(fetch, {
      url: serverEndpoint(
        this.agentHttp.serverHttpUrl(),
        "Agent Memory disposition",
        agentApiRoutes.cloud.memoryDisposition.path,
      ),
      agentApiKey,
      daemonApiKey: this.agentHttp.token(),
      method: "POST",
      body: request,
      what: "Memory disposition",
      timeoutMs: 30_000,
    });
  }

  async agentOpenviking(
    request: OpenVikingAgentProxyCommand,
    agentApiKey: string,
  ): Promise<unknown> {
    this.agentHttp.assertServerHttp();
    const url = serverEndpoint(
      this.agentHttp.serverHttpUrl(),
      "Agent OpenViking HTTP",
      agentApiRoutes.cloud.openviking.path,
    );
    if (request.op === "offer" || request.op === "diagnose") {
      return forwardOpenVikingControl({
        url,
        command: request,
        agentApiKey,
        daemonApiKey: this.agentHttp.token(),
      });
    }
    return forwardOpenVikingRead({
      url,
      command: request,
      agentApiKey,
      daemonApiKey: this.agentHttp.token(),
    });
  }

  async agentTask(request: TaskRequest, agentApiKey: string): Promise<TaskResponse> {
    this.agentHttp.assertServerHttp();
    return this.agentHttp.clients.task.execute({
      url: serverEndpoint(
        this.agentHttp.serverHttpUrl(),
        "Agent Task HTTP",
        agentApiRoutes.cloud.tasks.path,
      ),
      ...this.agentHttp.keys(agentApiKey),
      request,
    });
  }

  async agentChannel(
    request: AgentChannelRequest,
    agentApiKey: string,
  ): Promise<Record<string, unknown>> {
    this.agentHttp.assertServerHttp();
    const endpoint = channelEndpointFor(request.operation, request.target);
    return this.agentHttp.clients.channel.execute({
      method: endpoint.method,
      url: serverEndpoint(this.agentHttp.serverHttpUrl(), "Agent channel", endpoint.path),
      ...this.agentHttp.keys(agentApiKey),
      request,
    });
  }

  async agentActionPrepare(
    request: AgentActionPrepareRequest,
    agentApiKey: string,
  ): Promise<AgentActionPrepareResponse> {
    this.agentHttp.assertServerHttp();
    return this.agentHttp.clients.actionPrepare.execute({
      url: serverEndpoint(
        this.agentHttp.serverHttpUrl(),
        "Agent action-prepare HTTP",
        agentApiRoutes.cloud.actionPrepare.path,
      ),
      ...this.agentHttp.keys(agentApiKey),
      request,
    });
  }

  /** The endpoint, keys, liveness and client gate one Agent HTTP client needs. */
  protected agentPorts<T>(client: T) {
    return {
      assertConnected: () => this.agentHttp.assertServerHttp(),
      requireClient: (label: string, routeClient: unknown) =>
        this.requireAgentClient(label, routeClient),
      endpoint: (what: string, path: string) =>
        serverEndpoint(this.agentHttp.serverHttpUrl(), what, path),
      keys: (agentApiKey: string) => this.agentHttp.keys(agentApiKey),
      client,
    };
  }

  async agentWeeklyReport(
    request: WeeklyReportRequest,
    agentApiKey: string,
  ): Promise<WeeklyReportResponse> {
    return weeklyReport(this.agentPorts(this.agentHttp.clients.weeklyReport), request, agentApiKey);
  }

  async agentWeeklyReportCollect(
    request: WeeklyReportCollectCommand | WeeklyReportCollectFailRunningCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportCollectResult> {
    return weeklyReportCollect(
      this.agentPorts(this.agentHttp.clients.weeklyReport),
      request,
      agentApiKey,
    );
  }

  async agentWeeklyReportKeyPoints(
    request: WeeklyReportKeyPointsCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportKeyPointsResult> {
    return weeklyReportKeyPoints(
      this.agentPorts(this.agentHttp.clients.weeklyReport),
      request,
      agentApiKey,
    );
  }

  async agentWeeklyReportMemory(
    request: WeeklyReportMemoryCommand,
    agentApiKey: string,
  ): Promise<WeeklyReportMemoryResult> {
    return weeklyReportMemory(
      this.agentPorts(this.agentHttp.clients.weeklyReport),
      request,
      agentApiKey,
    );
  }

  /** The task idle reminder's question; `undefined` when this server has no such route (404). */
  async agentTaskIdleNudge(
    request: AgentTaskIdleNudgeRequest,
    agentApiKey: string,
  ): Promise<AgentTaskIdleNudgeResponse | undefined> {
    return taskIdleNudge(
      this.agentPorts(this.agentHttp.clients.taskIdleNudge),
      request,
      agentApiKey,
    );
  }

  protected forwardPorts(): ForwardPorts {
    return {
      assertConnected: () => this.agentHttp.assertServerHttp(),
      endpoint: (what, path) => serverEndpoint(this.agentHttp.serverHttpUrl(), what, path),
      keys: (agentApiKey) => this.agentHttp.keys(agentApiKey),
    };
  }

  agentAttachment(attachmentId: string, agentApiKey: string): Promise<Response> {
    return agentAttachment(this.forwardPorts(), attachmentId, agentApiKey);
  }

  agentAttachmentUpload(request: Request, agentApiKey: string): Promise<Response> {
    return agentAttachmentUpload(this.forwardPorts(), request, agentApiKey);
  }

  agentAttachmentUploadSessionCreate(body: unknown, agentApiKey: string): Promise<Response> {
    return agentAttachmentUploadSessionCreate(this.forwardPorts(), body, agentApiKey);
  }

  agentAttachmentUploadSessionComplete(uploadId: string, agentApiKey: string): Promise<Response> {
    return agentAttachmentUploadSessionComplete(this.forwardPorts(), uploadId, agentApiKey);
  }

  agentAttachmentUploadSessionCancel(uploadId: string, agentApiKey: string): Promise<Response> {
    return agentAttachmentUploadSessionCancel(this.forwardPorts(), uploadId, agentApiKey);
  }

  agentAttachmentUploadSessionGet(uploadId: string, agentApiKey: string): Promise<Response> {
    return agentAttachmentUploadSessionGet(this.forwardPorts(), uploadId, agentApiKey);
  }

  agentArtifact(request: AgentArtifactCall, agentApiKey: string): Promise<Response> {
    return agentArtifact(this.forwardPorts(), request, agentApiKey);
  }

  agentLabel(request: AgentLabelWriteRequest, agentApiKey: string): Promise<Response> {
    return agentLabel(this.forwardPorts(), request, agentApiKey);
  }

  agentApp(request: AgentAppRequest, agentApiKey: string): Promise<Response> {
    return agentApp(this.forwardPorts(), request, agentApiKey);
  }

  agentTaskConversation(
    request: AgentTaskConversationRequest,
    agentApiKey: string,
  ): Promise<Response> {
    return agentTaskConversation(this.forwardPorts(), request, agentApiKey);
  }

  private agentApiKeyEndpoint(): AgentApiKeyEndpoint {
    return {
      url: (what) => serverEndpoint(this.agentHttp.serverHttpUrl(), what, "/api/agent-api-keys"),
      token: () => this.agentHttp.token(),
    };
  }

  requestAgentApiKey(input: { agentId: string; workspaceId: string }): Promise<string> {
    return requestAgentApiKey(this.agentApiKeyEndpoint(), input);
  }

  requestAgentLaunchConfig(
    input: Parameters<typeof requestAgentLaunchConfig>[1],
  ): Promise<AgentLaunchConfig> {
    return requestAgentLaunchConfig(this.agentApiKeyEndpoint(), input);
  }

  revokeAgentApiKey(agentApiKey: string, scope?: "all"): Promise<void> {
    return revokeAgentApiKey(this.agentApiKeyEndpoint(), agentApiKey, scope);
  }
}
