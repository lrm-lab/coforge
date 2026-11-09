import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type { AgentSendReconciliationResponse } from "@lrm/coforge-sdk/agent";
import type { AgentMessageRequest, AgentReminderOperationRequest } from "@lrm/coforge-sdk/internal";
import { adaptAgentHistoryResponse } from "./agent-history-response";
import {
  adaptAgentReactionResponse,
  adaptAgentResolveResponse,
  adaptAgentSearchResponse,
  adaptAgentSendResponse,
} from "./agent-message-adapters";
import type {
  AgentMessageHttpClient,
  AgentMessageTransportResponse,
  AgentSendReconciliationRequest,
} from "./agent-http-clients";
import { messageEndpoint, serverEndpoint } from "./daemon-endpoints";

/** What an Agent's message operation needs from the connection that carries it. */
export type AgentMessagePorts = {
  /** Refuses the operation while the connection is not up: each one needs the server. */
  assertConnected(): void;
  connected: boolean;
  serverHttpUrl: string;
  /** Credentials for one Agent-scoped HTTP call: the Agent's own key plus the daemon key. */
  keys(agentApiKey: string): { agentApiKey: string; daemonApiKey: string };
  client: AgentMessageHttpClient;
};

export async function agentMessage(
  ports: AgentMessagePorts,
  request: AgentMessageRequest,
  agentApiKey: string,
): Promise<AgentMessageTransportResponse> {
  ports.assertConnected();
  const {
    requestRead,
    requestSearch,
    requestSend,
    requestResolve,
    requestReaction,
    requestEvents,
    requestChannelMute,
    requestThreadUnfollow,
  } = ports.client;
  if (request.operation === "check") {
    if (!requestEvents) throw new Error("unsupported Agent message operation: check");
    const url = messageEndpoint(ports.serverHttpUrl, agentApiRoutes.cloud.events.path);
    const events = await requestEvents({ url, ...ports.keys(agentApiKey), request });
    return {
      idempotencyKey: events.idempotencyKey,
      accepted: true,
      attentionCount: events.events.length,
      messages: events.events,
      messageId: "",
      hasMore: events.hasMore,
    };
  }
  if (request.operation === "mute" || request.operation === "unmute") {
    if (!requestChannelMute)
      throw new Error(`unsupported Agent message operation: ${request.operation}`);
    const muted = request.operation === "mute";
    const path = muted
      ? agentApiRoutes.cloud.channels.mute.path(request.target)
      : agentApiRoutes.cloud.channels.unmute.path(request.target);
    const url = messageEndpoint(ports.serverHttpUrl, path);
    const result = await requestChannelMute({
      url,
      ...ports.keys(agentApiKey),
      request: { ...request, muted },
    });
    return {
      idempotencyKey: result.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: [],
      messageId: "",
    };
  }
  if (request.operation === "thread-unfollow") {
    if (!requestThreadUnfollow)
      throw new Error("unsupported Agent message operation: thread-unfollow");
    const url = messageEndpoint(
      ports.serverHttpUrl,
      agentApiRoutes.cloud.threads.unfollow.path(request.target),
    );
    const result = await requestThreadUnfollow({ url, ...ports.keys(agentApiKey), request });
    return {
      idempotencyKey: result.idempotencyKey,
      accepted: true,
      attentionCount: 0,
      messages: [],
      messageId: "",
    };
  }
  if (request.operation === "resolve") {
    if (!requestResolve) throw new Error("unsupported Agent message operation: resolve");
    const url = messageEndpoint(
      ports.serverHttpUrl,
      agentApiRoutes.cloud.messages.resolve.path(request.messageId ?? ""),
    );
    return adaptAgentResolveResponse(
      await requestResolve({ url, ...ports.keys(agentApiKey), request }),
    );
  }
  if (request.operation === "react" || request.operation === "unreact") {
    if (!requestReaction)
      throw new Error(`unsupported Agent message operation: ${request.operation}`);
    const url = messageEndpoint(
      ports.serverHttpUrl,
      agentApiRoutes.cloud.messages.reactions.path(request.messageId ?? ""),
    );
    const method =
      request.operation === "react"
        ? agentApiRoutes.cloud.messages.reactions.add.method
        : agentApiRoutes.cloud.messages.reactions.remove.method;
    return adaptAgentReactionResponse(
      await requestReaction({ url, method, ...ports.keys(agentApiKey), request }),
    );
  }
  if (request.operation === "read") {
    if (!requestRead) throw new Error("unsupported Agent message operation: read");
    const url = messageEndpoint(ports.serverHttpUrl, agentApiRoutes.cloud.messages.list.path);
    return adaptAgentHistoryResponse(
      await requestRead({ url, ...ports.keys(agentApiKey), request }),
    );
  }
  if (request.operation === "search") {
    if (!requestSearch) throw new Error("unsupported Agent message operation: search");
    const url = messageEndpoint(ports.serverHttpUrl, agentApiRoutes.cloud.messages.search.path);
    return adaptAgentSearchResponse(
      await requestSearch({ url, ...ports.keys(agentApiKey), request }),
    );
  }
  if (request.operation === "send") {
    if (!requestSend) throw new Error("unsupported Agent message operation: send");
    const url = messageEndpoint(ports.serverHttpUrl, agentApiRoutes.cloud.messages.send.path);
    return adaptAgentSendResponse(await requestSend({ url, ...ports.keys(agentApiKey), request }));
  }
  throw new Error(`unsupported Agent message operation: ${request.operation}`);
}

export async function reconcileAgentSend(
  ports: AgentMessagePorts,
  request: AgentSendReconciliationRequest,
  agentApiKey: string,
): Promise<AgentSendReconciliationResponse> {
  ports.assertConnected();
  const { requestSendReconciliation } = ports.client;
  if (!requestSendReconciliation)
    throw new Error("unsupported Agent message operation: send reconciliation");
  return requestSendReconciliation({
    url: messageEndpoint(ports.serverHttpUrl, agentApiRoutes.cloud.messages.send.path),
    ...ports.keys(agentApiKey),
    request,
  });
}

export async function agentReminder(
  ports: AgentMessagePorts,
  request: AgentReminderOperationRequest,
  agentApiKey: string,
) {
  if (!ports.connected || !ports.serverHttpUrl)
    throw new Error("daemon connection is not connected");
  if (!ports.client.requestReminder) throw new Error("Agent reminder HTTP client is unavailable");
  const response = await ports.client.requestReminder({
    url: serverEndpoint(ports.serverHttpUrl, "Agent reminder", agentApiRoutes.cloud.reminders.path),
    ...ports.keys(agentApiKey),
    request,
  });
  for (const field of ["idempotencyKey", "workspaceId", "computerId", "agentId"] as const)
    if (response[field] !== request[field]) throw new Error("uncorrelated Agent reminder response");
  return response;
}
