import { taskRefusalError } from "./agent-task-refusal";
import type { AgentMessageTransportResponse } from "./agent-message-adapters";
import type {
  AgentHistoryResponse,
  AgentSearchResponse,
  AgentSendDecisionResponse,
  AgentSendReconciliationResponse,
  AgentResolveResponse,
  AgentReactionResponse,
  AgentEventsResponse,
  AgentChannelAttentionResponse,
  AgentThreadAttentionResponse,
  AgentActionPrepareRequest,
  AgentActionPrepareResponse,
  GitHubCredentialRequest,
  GitHubCredentialResponse,
  GitHubCommitTrailersRequest,
  GitHubCommitTrailersResponse,
  AgentManualErrorCode,
  AgentManualGetRequest,
  AgentManualGetResponse,
  AgentManualSearchRequest,
  AgentManualSearchResponse,
  AgentUserInfoRequest,
  AgentUserInfoResponse,
  AgentUserInfoErrorCode,
  AgentProfileShowRequest,
  AgentProfileShowResponse,
  AgentProfileUpdateRequest,
  AgentProfileUpdateResponse,
  AgentProfileErrorCode,
  AgentAppConfigErrorCode,
  AgentAppConfigGetRequest,
  AgentAppConfigResponse,
  AgentAppConfigUpdateRequest,
} from "@lrm/coforge-sdk/agent";
import {
  decodeGitHubCredentialResponse,
  decodeGitHubCommitTrailersResponse,
} from "@lrm/coforge-sdk/agent";
import type {
  TaskRequest,
  TaskResponse,
  WeeklyReportRequest,
  WeeklyReportResponse,
  ChannelCommand,
  AgentMessageRequest,
  WorkspaceInfoRequest,
  WorkspaceInfoResponse,
  AgentReminderOperationRequest,
  AgentReminderOperationResponse,
} from "@lrm/coforge-sdk/internal";
import { AGENT_SEND_REQUEST_TIMEOUT_MS } from "@lrm/coforge-sdk/internal";
import { AgentTransportError } from "./agent-transport-error";
import { AgentManualRequestError } from "./agent-manual-request-error";
import { AgentUserInfoRequestError } from "./agent-user-info-request-error";
import { AgentProfileRequestError } from "./agent-profile-request-error";
import { AgentAppConfigRequestError } from "./agent-app-config-request-error";
import {
  createAgentAttentionHttpClient,
  type AgentAttentionHttpClient,
} from "./agent-attention-http-clients";
import { AgentWeeklyReportRequestError } from "./agent-weekly-report-request-error";
import { AgentUpstreamRefusalError } from "./agent-upstream-refusal-error";
import {
  AGENT_RPC_TIMEOUT_MS,
  agentHeaders,
  assertAgentResponseOk,
  fetchAgentResponse,
  getAgentEnvelopeJson,
  getAgentJson,
  isRecord,
  postAgentEnvelopeJson,
  readAgentResponseJson,
  readUpstreamErrorCode,
  sendAgentJson,
  validateAgentMessageArrayShape,
  validateAgentSendReconciliationShape,
  validateAgentSendResponseShape,
  type AgentHttpInput,
  type HttpFetch,
} from "./agent-http-wire";

/** Agent HTTPS clients: contracts, response adapters, and default implementations.
 * Moved verbatim from `daemon-connection.ts`: no behaviour change, only a home. */
export interface AgentMessageHttpClient extends AgentAttentionHttpClient {
  requestRead?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentHistoryResponse>;
  requestSearch?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentSearchResponse>;
  requestSend?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentSendDecisionResponse>;
  requestSendReconciliation?(
    input: AgentHttpInput<AgentSendReconciliationRequest>,
  ): Promise<AgentSendReconciliationResponse>;
  requestResolve?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentResolveResponse>;
  requestReaction?(
    input: AgentHttpInput<AgentMessageRequest> & { method: "POST" | "DELETE" },
  ): Promise<AgentReactionResponse>;
  /** `check` drains the server-side pending events page; the server advances the read boundary. */
  requestEvents?(input: AgentHttpInput<AgentMessageRequest>): Promise<AgentEventsResponse>;
  requestChannelMute?(
    input: AgentHttpInput<AgentMessageRequest & { muted: boolean }>,
  ): Promise<AgentChannelAttentionResponse>;
  requestThreadUnfollow?(
    input: AgentHttpInput<AgentMessageRequest>,
  ): Promise<AgentThreadAttentionResponse>;
  requestReminder?(
    input: AgentHttpInput<AgentReminderOperationRequest>,
  ): Promise<AgentReminderOperationResponse>;
  requestWorkspaceInfo?(
    input: AgentHttpInput<WorkspaceInfoRequest>,
  ): Promise<WorkspaceInfoResponse>;
  requestGitHubCredential?(
    input: AgentHttpInput<GitHubCredentialRequest>,
  ): Promise<GitHubCredentialResponse>;
  requestGitHubCommitTrailers?(
    input: AgentHttpInput<GitHubCommitTrailersRequest>,
  ): Promise<GitHubCommitTrailersResponse>;
  requestManualGet?(input: AgentHttpInput<AgentManualGetRequest>): Promise<AgentManualGetResponse>;
  requestManualSearch?(
    input: AgentHttpInput<AgentManualSearchRequest>,
  ): Promise<AgentManualSearchResponse>;
  requestUserInfo?(input: AgentHttpInput<AgentUserInfoRequest>): Promise<AgentUserInfoResponse>;
  requestProfileShow?(
    input: AgentHttpInput<AgentProfileShowRequest>,
  ): Promise<AgentProfileShowResponse>;
  requestProfileUpdate?(
    input: AgentHttpInput<AgentProfileUpdateRequest>,
  ): Promise<AgentProfileUpdateResponse>;
  requestAppConfigGet?(
    input: AgentHttpInput<AgentAppConfigGetRequest>,
  ): Promise<AgentAppConfigResponse>;
  requestAppConfigUpdate?(
    input: AgentHttpInput<AgentAppConfigUpdateRequest>,
  ): Promise<AgentAppConfigResponse>;
}

/**
 * The internal shape `DaemonConnection.agentMessage` returns to `DaemonRuntime`, carrying exactly
 * what `DaemonRuntime` consumes across every Agent message operation. Each per-route HTTP response
 * type (`AgentHistoryResponse`/`AgentSearchResponse`/`AgentSendResponse`/`AgentResolveResponse`/
 * `AgentReactionResponse`/`AgentEventsResponse`/`AgentChannelAttentionResponse`/
 * `AgentThreadAttentionResponse`) is adapted into this shape by `agentMessage`.
 */
/** What a `reconcileOnly` request names: the send's key and target, in its Agent's scope. */
export type AgentSendReconciliationRequest = Pick<
  AgentMessageRequest,
  "idempotencyKey" | "agentId" | "workspaceId" | "target"
>;

export type { AgentMessageTransportResponse };

export interface AgentTaskHttpClient {
  execute(input: AgentHttpInput<TaskRequest>): Promise<TaskResponse>;
}
export type AgentChannelRequest = ChannelCommand & {
  workspaceId: string;
  agentId: string;
};
export interface AgentChannelHttpClient {
  execute(
    input: AgentHttpInput<AgentChannelRequest> & { method: "GET" | "POST" | "PATCH" | "DELETE" },
  ): Promise<Record<string, unknown>>;
}
export interface AgentActionPrepareHttpClient {
  execute(input: AgentHttpInput<AgentActionPrepareRequest>): Promise<AgentActionPrepareResponse>;
}
export interface AgentWeeklyReportHttpClient {
  request(input: AgentHttpInput<WeeklyReportRequest>): Promise<WeeklyReportResponse>;
}
export interface AgentWeeklyReportCollectHttpClient {
  execute(
    input: AgentHttpInput<
      | import("./weekly-report-collect").WeeklyReportCollectCommand
      | import("./weekly-report-collect").WeeklyReportCollectFailRunningCommand
    >,
  ): Promise<import("./weekly-report-collect").WeeklyReportCollectResult>;
}
export interface AgentWeeklyReportKeyPointsHttpClient {
  execute(
    input: AgentHttpInput<import("./weekly-report-key-points").WeeklyReportKeyPointsCommand>,
  ): Promise<import("./weekly-report-key-points").WeeklyReportKeyPointsResult>;
}
export interface AgentWeeklyReportMemoryHttpClient {
  execute(
    input: AgentHttpInput<import("./weekly-report-memory").WeeklyReportMemoryCommand>,
  ): Promise<import("./weekly-report-memory").WeeklyReportMemoryResult>;
}

function manualRequestError(errorCode: string, message: string, status: number): Error {
  return new AgentManualRequestError(errorCode as AgentManualErrorCode, message, status);
}

function profileRequestError(errorCode: string, message: string, status: number): Error {
  return new AgentProfileRequestError(errorCode as AgentProfileErrorCode, message, status);
}

const appConfigError = (errorCode: string, message: string, status: number) =>
  new AgentAppConfigRequestError(errorCode as AgentAppConfigErrorCode, message, status);

export const createAgentMessageHttpClient = (
  httpClient: HttpFetch = globalThis.fetch,
): AgentMessageHttpClient => ({
  requestRead: ({ request, ...keys }) =>
    getAgentJson(httpClient, {
      ...keys,
      what: "agent read",
      // A read also resolves a send's short thread target, so it shares the send's deadline.
      timeoutMs: AGENT_SEND_REQUEST_TIMEOUT_MS,
      query: {
        target: request.target,
        idempotencyKey: request.idempotencyKey,
        before: request.before,
        after: request.after,
        around: request.around,
        limit: request.limit,
        fromSequence: request.fromSequence,
        throughSequence: request.throughSequence,
        unread: request.unread ? "true" : undefined,
      },
      validate: validateAgentMessageArrayShape("messages"),
    }),
  requestSearch: ({ request, ...keys }) =>
    getAgentJson(httpClient, {
      ...keys,
      what: "agent search",
      query: {
        idempotencyKey: request.idempotencyKey,
        query: request.query,
        target: request.target,
        sender: request.sender,
        sort: request.sort,
        before: request.before,
        after: request.after,
        limit: request.limit,
        offset: request.offset,
        cursor: request.cursor,
      },
      validate: validateAgentMessageArrayShape("results"),
    }),
  requestSend: ({ request, ...keys }) =>
    sendAgentJson<AgentSendDecisionResponse>(httpClient, {
      ...keys,
      method: "POST",
      what: "agent send",
      timeoutMs: AGENT_SEND_REQUEST_TIMEOUT_MS,
      // The send body's field names: the idempotency key is `idempotencyKey`, `sendDraft` is
      // declared when this send is the resend of a held draft, and `mentions` is the structured
      // list. The body carries no `continue` field; the force-send flag is `continueAnyway`.
      body: {
        idempotencyKey: request.idempotencyKey,
        target: request.target,
        content: request.content,
        continueAnyway: request.continueAnyway,
        sendDraft: request.sendDraft,
        draftReholdCount: request.draftReholdCount,
        draftReplacedExisting: request.draftReplacedExisting,
        seenUpToSeq: request.seenUpToSeq,
        seenExactSeqs: request.seenExactSeqs,
        freshnessContextMode: request.freshnessContextMode,
        attachmentIds: request.attachmentIds,
        mentions: request.mentions,
      },
      validate: validateAgentSendResponseShape,
    }),
  /** The `reconcileOnly` request on the send route: it asks only whether this key already
   * committed, so it carries the key and the target and nothing that could send or hold. */
  requestSendReconciliation: ({ request, ...keys }) =>
    sendAgentJson<AgentSendReconciliationResponse>(httpClient, {
      ...keys,
      method: "POST",
      what: "agent send reconciliation",
      timeoutMs: AGENT_SEND_REQUEST_TIMEOUT_MS,
      body: { idempotencyKey: request.idempotencyKey, target: request.target, reconcileOnly: true },
      validate: validateAgentSendReconciliationShape,
    }),
  requestEvents: ({ request, ...keys }) =>
    getAgentJson<AgentEventsResponse>(httpClient, {
      ...keys,
      what: "agent events",
      query: {
        idempotencyKey: request.idempotencyKey,
        limit: request.limit,
        ...(request.target ? { target: request.target } : {}),
      },
      validate: validateAgentMessageArrayShape("events"),
    }),
  requestChannelMute: ({ request, ...keys }) =>
    sendAgentJson<AgentChannelAttentionResponse>(httpClient, {
      ...keys,
      method: "POST",
      what: "agent channel attention",
      body: { idempotencyKey: request.idempotencyKey },
    }),
  requestThreadUnfollow: ({ request, ...keys }) =>
    sendAgentJson<AgentThreadAttentionResponse>(httpClient, {
      ...keys,
      method: "POST",
      what: "agent thread attention",
      body: { idempotencyKey: request.idempotencyKey },
    }),
  requestResolve: ({ request, ...keys }) =>
    getAgentJson<AgentResolveResponse>(httpClient, {
      ...keys,
      what: "agent resolve",
      query: { idempotencyKey: request.idempotencyKey },
      validate: (data) =>
        isRecord(data) && isRecord(data.message)
          ? undefined
          : "response is missing the message object",
    }),
  requestReaction: ({ request, ...keys }) =>
    sendAgentJson<AgentReactionResponse>(httpClient, {
      ...keys,
      what: "agent reaction",
      body: { idempotencyKey: request.idempotencyKey, emoji: request.emoji },
    }),
  async requestWorkspaceInfo({ request, ...keys }) {
    const data = await getAgentJson<Omit<WorkspaceInfoResponse, "idempotencyKey">>(httpClient, {
      ...keys,
      what: "workspace_info",
      query: {},
    });
    return { ...data, idempotencyKey: request.idempotencyKey };
  },
  requestManualGet: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentManualGetResponse>(
      httpClient,
      {
        ...keys,
        what: "agent manual get",
        query: { topic: request.topic, intent: request.intent, reason: request.reason },
      },
      manualRequestError,
    ),
  requestManualSearch: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentManualSearchResponse>(
      httpClient,
      {
        ...keys,
        what: "agent manual search",
        query: { query: request.query, intent: request.intent, reason: request.reason },
      },
      manualRequestError,
    ),
  requestUserInfo: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentUserInfoResponse>(
      httpClient,
      { ...keys, what: "agent user info", query: {} },
      (errorCode, message, status) =>
        new AgentUserInfoRequestError(errorCode as AgentUserInfoErrorCode, message, status),
    ),
  requestProfileShow: ({ request, ...keys }) =>
    getAgentEnvelopeJson<AgentProfileShowResponse>(
      httpClient,
      { ...keys, what: "agent profile show", query: { target: request.target } },
      profileRequestError,
    ),
  requestProfileUpdate: ({ request, ...keys }) =>
    postAgentEnvelopeJson<AgentProfileUpdateResponse>(
      httpClient,
      { ...keys, what: "agent profile update", body: request },
      profileRequestError,
    ),
  requestAppConfigGet: ({ request: _request, ...keys }) =>
    getAgentEnvelopeJson<AgentAppConfigResponse>(
      httpClient,
      { ...keys, what: "agent app config get", query: {} },
      appConfigError,
    ),
  // The App is the URL's; the body is the change alone.
  requestAppConfigUpdate: ({ request: { appId: _appId, ...change }, ...keys }) =>
    postAgentEnvelopeJson<AgentAppConfigResponse>(
      httpClient,
      { ...keys, what: "agent app config update", method: "PATCH", body: change },
      appConfigError,
    ),
  ...createAgentAttentionHttpClient(httpClient),
  // Through the shared wire helpers, so a refusal reaches the proxy as the cloud's own status, reason
  // and code, and a network failure as a typed transport failure, never a bare message. A lookup is
  // a read, so a 5xx that names its code (`TEMPORARILY_UNAVAILABLE`) is the cloud's answer, relayed
  // with that status and code; a bare 5xx stays a transport failure.
  async requestGitHubCredential({ url, request, ...keys }) {
    const what = "GitHub credential";
    const response = await fetchAgentResponse(
      httpClient,
      url,
      {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      },
      what,
    );
    const upstreamCode =
      response.status >= 500 ? await readUpstreamErrorCode(response.clone()) : undefined;
    if (upstreamCode)
      throw new AgentUpstreamRefusalError(
        `${what} request failed (${response.status})`,
        upstreamCode,
        response.status,
      );
    await assertAgentResponseOk(response, what);
    return decodeGitHubCredentialResponse(await readAgentResponseJson<unknown>(response, what));
  },
  async requestGitHubCommitTrailers({ url, request, ...keys }) {
    const response = await httpClient(url, {
      method: "POST",
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub commit trailers request failed (${response.status})`);
    return decodeGitHubCommitTrailersResponse(await response.json());
  },
  async requestReminder({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await httpClient(url, {
        method: "POST",
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      });
    } catch {
      throw new Error("Agent reminder request failed");
    }
    if (!response.ok) {
      // The server names *why* it refused in the body's `code`, exactly as the Task route does; it
      // must not ride in the caller-facing message, but it is the only record of the cause, so it is
      // attached for the daemon's own log (see `classifyAgentProxyFailure`).
      const upstreamCode = await readUpstreamErrorCode(response);
      throw new AgentUpstreamRefusalError(
        `Agent reminder request failed (${response.status})`,
        upstreamCode,
        response.status,
      );
    }
    let envelope: AgentReminderOperationResponse;
    try {
      envelope = (await response.json()) as AgentReminderOperationResponse;
    } catch {
      throw new Error("Agent reminder response is malformed");
    }
    if (!envelope || typeof envelope.idempotencyKey !== "string")
      throw new Error("Agent reminder response is malformed");
    return envelope;
  },
});

export const defaultAgentMessageHttpClient = createAgentMessageHttpClient();

export const defaultAgentWeeklyReportHttpClient: AgentWeeklyReportHttpClient = {
  async request({ url, request, ...keys }) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const message = await response.text();
      if (response.status === 400 || response.status === 403)
        throw new AgentWeeklyReportRequestError(
          message.trim() ||
            (response.status === 403
              ? "Weekly report access denied"
              : "invalid weekly-report request"),
        );
      throw new Error(`server Agent weekly-report request failed (${response.status})`);
    }
    const result = (await response.json()) as WeeklyReportResponse;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report response idempotency key does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportCollectHttpClient: AgentWeeklyReportCollectHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-collect", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse(
        "Agent weekly-report-collect",
        response.status,
      );
    const result =
      (await response.json()) as import("./weekly-report-collect").WeeklyReportCollectResult;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report-collect response idempotency key does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportKeyPointsHttpClient: AgentWeeklyReportKeyPointsHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-key-points", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse(
        "Agent weekly-report-key-points",
        response.status,
      );
    const result =
      (await response.json()) as import("./weekly-report-key-points").WeeklyReportKeyPointsResult;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report-key-points response idempotency key does not match request");
    return result;
  },
};

export const defaultAgentWeeklyReportMemoryHttpClient: AgentWeeklyReportMemoryHttpClient = {
  async execute({ url, request, ...keys }) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      });
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent weekly-report-memory", cause);
    }
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse("Agent weekly-report-memory", response.status);
    const result =
      (await response.json()) as import("./weekly-report-memory").WeeklyReportMemoryResult;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("weekly-report-memory response idempotency key does not match request");
    return result;
  },
};

/** `timeoutMs` bounds each request; production's client uses `AGENT_RPC_TIMEOUT_MS`. */
export const createAgentTaskHttpClient = (timeoutMs: number): AgentTaskHttpClient => ({
  async execute({ url, request, ...keys }) {
    // `TaskRequest` already names the key `idempotencyKey` (the one HTTP name), so the body goes up
    // as-is; the response echoes it for correlation.
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: agentHeaders(keys, true),
      body: JSON.stringify(request),
    });
    if (!response.ok) throw await taskRefusalError(response);
    const result = (await response.json()) as TaskResponse;
    if (result.idempotencyKey !== request.idempotencyKey)
      throw new Error("Task response idempotency key does not match request");
    return result;
  },
});

export const defaultAgentTaskHttpClient = createAgentTaskHttpClient(AGENT_RPC_TIMEOUT_MS);

/** Forwards the classified channel request to its mapped cloud route and returns the JSON
 * response body unchanged. A non-2xx throws a typed `AgentTransportError` carrying the real
 * upstream status (so, e.g., a 404 "channel not found" reaches the CLI as a 404, not a generic
 * 502); a network failure is the same pre-response transport failure every other Agent HTTP
 * client here reports. */
export const defaultAgentChannelHttpClient: AgentChannelHttpClient = {
  async execute({ url, method, request, ...keys }) {
    let response: Response;
    try {
      if (method === "GET") {
        const endpoint = new URL(url);
        endpoint.searchParams.set("idempotencyKey", request.idempotencyKey);
        response = await fetch(endpoint, {
          method: "GET",
          headers: agentHeaders(keys),
          signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        });
      } else {
        response = await fetch(url, {
          method: method as "POST" | "PATCH" | "DELETE",
          signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
          headers: agentHeaders(keys, true),
          body: JSON.stringify(request),
        });
      }
    } catch (cause) {
      throw AgentTransportError.preResponseTransport("Agent Channel", cause);
    }
    // A typed error (not a bare Error) so the real upstream status (e.g. 404 "channel not
    // found") survives classification instead of collapsing into a generic 502; the CLI
    // (local-client.ts#callChannel) turns a preserved 404 into CliError code NOT_FOUND.
    if (!response.ok)
      throw AgentTransportError.upstreamHttpResponse("Agent Channel", response.status);
    return (await response.json()) as Record<string, unknown>;
  },
};

export const defaultAgentActionPrepareHttpClient: AgentActionPrepareHttpClient = {
  async execute({ url, request, ...keys }) {
    const response = await fetchAgentResponse(
      fetch,
      url,
      {
        method: "POST",
        signal: AbortSignal.timeout(AGENT_RPC_TIMEOUT_MS),
        headers: agentHeaders(keys, true),
        body: JSON.stringify(request),
      },
      "agent action prepare",
    );
    await assertAgentResponseOk(response, "agent action prepare");
    const result = (await response.json()) as AgentActionPrepareResponse;
    if (!result || typeof result.messageId !== "string" || result.metadata?.kind !== "action-card")
      throw new Error("action-prepare response is malformed");
    return result;
  },
};
