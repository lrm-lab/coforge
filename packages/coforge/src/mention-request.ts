import {
  agentApiRoutes,
  decodeAgentMentionActionErrorResponse,
  decodeAgentMentionDeliveryErrorResponse,
  decodeAgentMentionDeliveryResponse,
  type AgentMentionDeliveryResponse,
  type AgentMentionExecuteRequest,
} from "@lrm/coforge-sdk/agent";
import { CliError } from "./cli-error";
import { operationFailedCode, requireProxySetup } from "./proxy-request";

/**
 * One mention action route through the local Proxy. A 5xx is `SERVER_5XX`; any other refusal is
 * `<OPERATION>_FAILED` carrying the server's own error text (the `{ ok: false, errorCode, error }`
 * envelope, the Proxy's JSON error, or its bare text).
 */
export async function mentionActionRequest<T>(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  operation: "mention-pending" | "mention-action",
  route: { method: string; path: string; search?: string },
  body: AgentMentionExecuteRequest | undefined,
  decode: (value: unknown) => T,
): Promise<T> {
  requireProxySetup(operation, context, proxyUrl);
  let response: Response;
  try {
    const endpoint = proxyEndpoint(route.path);
    endpoint.search = route.search ?? "";
    response = await fetch(endpoint, {
      method: route.method,
      headers: {
        authorization: `Bearer ${context}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: operationFailedCode(operation),
      message: "agent proxy request failed (network or timeout)",
      retryable: false,
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      const parsed: unknown = JSON.parse(text);
      const envelope = decodeAgentMentionActionErrorResponse(parsed);
      const proxyError = (parsed as { error?: unknown } | null)?.error;
      message = envelope?.error ?? (typeof proxyError === "string" ? proxyError : text);
    } catch {
      // A bare-text Proxy error (e.g. "bad request"): its text is the message.
    }
    throw new CliError({
      code: response.status >= 500 ? "SERVER_5XX" : operationFailedCode(operation),
      message: message || `HTTP ${response.status}`,
      retryable: false,
    });
  }
  return decode(await response.json().catch(() => undefined));
}

/** A mention delivery failure that is not the server's own answer; `MENTION_DELIVERY_FAILED` is
 * already the code of a send whose @mentions reached no one. */
const MENTION_DELIVERY_LOOKUP_FAILED = "MENTION_DELIVERY_LOOKUP_FAILED";

/**
 * Mention delivery through the local Proxy. The server's own answers keep their code
 * (`MESSAGE_NOT_FOUND`, `AMBIGUOUS_MESSAGE_ID`); a 5xx is `SERVER_5XX`, and any other refusal is
 * `MENTION_DELIVERY_LOOKUP_FAILED` with the Proxy's text. The lookup is a read, so a network
 * failure or a 5xx is retryable.
 */
export async function mentionDeliveryRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  messageId: string,
): Promise<AgentMentionDeliveryResponse> {
  requireProxySetup("mention-delivery", context, proxyUrl);
  const route = agentApiRoutes.local.mentionDeliveries;
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(route.path(messageId)), {
      method: route.method,
      headers: { authorization: `Bearer ${context}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CliError({
      code: MENTION_DELIVERY_LOOKUP_FAILED,
      message: "agent proxy request failed (network or timeout)",
      retryable: true,
    });
  }
  if (response.ok) return decodeAgentMentionDeliveryResponse(await response.json());
  const text = await response.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A bare-text Proxy error (e.g. "bad request"): its text is the message.
  }
  const envelope = decodeAgentMentionDeliveryErrorResponse(parsed);
  const proxyError = (parsed as { error?: unknown } | undefined)?.error;
  const serverFailure = response.status >= 500;
  throw new CliError({
    code: envelope
      ? envelope.errorCode.toUpperCase()
      : serverFailure
        ? "SERVER_5XX"
        : MENTION_DELIVERY_LOOKUP_FAILED,
    message:
      (envelope?.error ?? (typeof proxyError === "string" ? proxyError : text)) ||
      `HTTP ${response.status}`,
    retryable: !envelope && serverFailure,
  });
}
