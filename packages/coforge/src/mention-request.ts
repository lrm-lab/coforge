import {
  decodeAgentMentionActionErrorResponse,
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
