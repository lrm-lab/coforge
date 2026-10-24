import {
  agentApiRoutes,
  decodeAgentInboxListResponse,
  type AgentInboxListResponse,
  type AgentInboxRequest,
} from "@lrm/coforge-sdk/agent";
import { envelopeRequest } from "./proxy-request";

/** What the daemon holds for the Agent itself: messages not yet delivered and App items. */
export async function inboxCheckRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
) {
  if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
    throw new Error("coforge agent context is invalid");
  if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
  const response = await fetch(proxyEndpoint(agentApiRoutes.proxy.inbox.path), {
    method: agentApiRoutes.local.inbox.method,
    headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), operation: "check" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`agent inbox request failed (${response.status})`);
  return response.json();
}

/** The server's unread conversations (`inbox check --view`/`--before`). */
export function inboxListRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  { view, before }: AgentInboxRequest,
): Promise<AgentInboxListResponse> {
  return envelopeRequest(
    proxyEndpoint,
    context,
    proxyUrl,
    {
      ...agentApiRoutes.local.inboxList,
      query: {
        ...(view ? { view } : {}),
        ...(before === undefined ? {} : { before: String(before) }),
      },
    },
    decodeAgentInboxListResponse,
    () => undefined,
    "inbox-check",
  );
}
