import { teamMemoryRequests } from "./team-memory-request";
import { CliError } from "./cli-error";
import { actionWithdrawRequest, inboxDismissRequest, inboxReadRequest } from "./inbox-commands";
import { memoryRequests } from "./memory-request";
import { procRequests } from "./proc-request";
import { proxyHttpFailure } from "./local-proxy-failure";
import { readProxyErrorBody, requireProxySetup } from "./proxy-request";
import {
  agentApiRoutes,
  decodeAgentVersionResponse,
  decodeAgentContextQueryResponse,
  type AgentCommandGuidanceRequest,
  type AgentCommandGuidanceResponse,
  type AgentContextReadRequest,
  type AgentContextSearchRequest,
  type AgentContextQueryResponse,
  type AgentInboxDismissRequest,
  type AgentInboxReadRequest,
  type AgentThreadAttentionResponse,
  type AgentVersionResponse,
} from "@lrm/coforge-sdk/agent";

/**
 * GETs the local-only `/api/agent/v1/version` route: unlike
 * `manualRequest` above, this never reaches Web/backend, so a non-ok response is always a local
 * proxy/daemon condition, never a domain error envelope. A network/timeout failure is reported as
 * "the live daemon could not be queried", matching `coforge version`'s own refusal wording for a
 * daemon that never answered.
 */
export async function versionRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Promise<AgentVersionResponse> {
  requireProxySetup("version", context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.proxy.version.path), {
      method: agentApiRoutes.proxy.version.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "VERSION_FAILED",
      message:
        "The live daemon could not be queried: agent proxy request failed (network or timeout).",
      retryable: false,
    });
  }
  if (!response.ok) {
    const errorBody = await readProxyErrorBody(response);
    throw proxyHttpFailure("version", response.status, errorBody, undefined);
  }
  return decodeAgentVersionResponse(await response.json().catch(() => undefined));
}

export async function contextQueryRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentContextSearchRequest | AgentContextReadRequest,
): Promise<AgentContextQueryResponse> {
  requireProxySetup("context", context, proxyUrl);
  const route =
    request.mode === "search"
      ? agentApiRoutes.local.context.search
      : agentApiRoutes.local.context.read;
  const endpoint = proxyEndpoint(route.path);
  const query =
    request.mode === "search"
      ? {
          message_id: request.messageId,
          session_id: request.sessionId,
          query: request.query,
          limit: request.limit,
          offset: request.offset,
        }
      : {
          message_id: request.messageId,
          session_id: request.sessionId,
          around: request.around,
          limit: request.limit,
          page: request.page,
        };
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) endpoint.searchParams.set(key, String(value));
  }
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: route.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "CONTEXT_QUERY_FAILED",
      message: "The live daemon could not be queried for Agent context.",
      retryable: false,
    });
  }
  if (!response.ok)
    throw proxyHttpFailure(
      "context",
      response.status,
      await readProxyErrorBody(response),
      undefined,
    );
  return decodeAgentContextQueryResponse(await response.json().catch(() => undefined));
}

export function contextRequests(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) {
  return {
    contextSearch: (request: Omit<AgentContextSearchRequest, "mode">) =>
      contextQueryRequest(proxyEndpoint, context, proxyUrl, { ...request, mode: "search" }),
    contextRead: (request: Omit<AgentContextReadRequest, "mode">) =>
      contextQueryRequest(proxyEndpoint, context, proxyUrl, { ...request, mode: "read" }),
  };
}

export async function threadFollowRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  target: string,
): Promise<AgentThreadAttentionResponse> {
  requireProxySetup("thread-follow", context, proxyUrl);
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.proxy.threadFollow.path(target)), {
      method: agentApiRoutes.proxy.threadFollow.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: "THREAD_FOLLOW_FAILED",
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw proxyHttpFailure(
      "thread-follow",
      response.status,
      await readProxyErrorBody(response),
      target,
    );
  }
  return (await response.json()) as AgentThreadAttentionResponse;
}

export async function commandGuidanceRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  request: AgentCommandGuidanceRequest,
): Promise<AgentCommandGuidanceResponse> {
  requireProxySetup("guidance", context, proxyUrl);
  try {
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.guidance.path), {
      method: agentApiRoutes.proxy.guidance.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: true, guidance: null };
    const body = (await response.json().catch(() => undefined)) as
      | Partial<AgentCommandGuidanceResponse>
      | undefined;
    return {
      ok: true,
      guidance: typeof body?.guidance === "string" ? body.guidance : null,
      ...(body?.mode ? { mode: body.mode } : {}),
    };
  } catch {
    return { ok: true, guidance: null };
  }
}

export function localAgentRequests(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) {
  return {
    version: () => versionRequest(proxyEndpoint, context, proxyUrl),
    commandGuidance: (request: AgentCommandGuidanceRequest) =>
      commandGuidanceRequest(proxyEndpoint, context, proxyUrl, request),
    inboxRead: (request: AgentInboxReadRequest) =>
      inboxReadRequest(proxyEndpoint, context, proxyUrl, request),
    inboxDismiss: (request: AgentInboxDismissRequest) =>
      inboxDismissRequest(proxyEndpoint, context, proxyUrl, request),
    actionWithdraw: (messageId: string) =>
      actionWithdrawRequest(proxyEndpoint, context, proxyUrl, messageId),
    ...contextRequests(proxyEndpoint, context, proxyUrl),
    ...teamMemoryRequests(proxyEndpoint, context, proxyUrl),
    ...memoryRequests(proxyEndpoint, context, proxyUrl),
    ...procRequests(proxyEndpoint, context, proxyUrl),
  };
}
/**
 * GETs the local-only `/api/agent/v1/computer-update-notice` route: like `version` it never
 * reaches Web/backend, so a failure is always a local condition — and unlike `version` it is
 * append-only output, so any refusal or transport failure reads as "no notice", never an error.
 */
export async function computerUpdateNoticeRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
): Promise<{ ok: true; notice: string | null }> {
  requireProxySetup("computer-update-notice", context, proxyUrl);
  try {
    const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.computerUpdateNotice.path), {
      method: agentApiRoutes.proxy.computerUpdateNotice.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: true, notice: null };
    const body = (await response.json().catch(() => undefined)) as { notice?: unknown } | undefined;
    return { ok: true, notice: typeof body?.notice === "string" ? body.notice : null };
  } catch {
    return { ok: true, notice: null };
  }
}
