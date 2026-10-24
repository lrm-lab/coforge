import { getLogger } from "@logtape/logtape";
import { classifyAgentProxyFailure, AGENT_PROXY_CORRELATION_HEADER } from "./agent-proxy-failure";

const logger = getLogger(["coforge", "daemon", "agent-proxy"]);

/** Attachment responses retain their encoded bytes and representation metadata. Connection
 * fields belong to the upstream hop; Bun frames the response for the local connection. */
export function forwardResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const connectionFields = (headers.get("connection") ?? "").split(",");
  for (const field of [
    ...connectionFields,
    "connection",
    "keep-alive",
    "proxy-connection",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    if (field.trim()) headers.delete(field.trim());
  }
  return new Response(response.body, { status: response.status, headers });
}

/**
 * Classifies a thrown error into the local daemon proxy's JSON error contract (never a bare,
 * unlabeled 502), logs it once at WARN, and carries the same correlation id on a response header.
 */
export function proxyFailureResponse(
  error: unknown,
  context: { method: string; path: string; routeFamily: string; agentId: string; redact?: boolean },
): Response {
  const classified = classifyAgentProxyFailure(error, context);
  logger.warn("Agent proxy request failed", {
    event: "agent.proxy.failure",
    ...classified.logFields,
  });
  return Response.json(classified.body, {
    status: classified.status,
    headers: { [AGENT_PROXY_CORRELATION_HEADER]: classified.body.proxy.correlation_id },
  });
}
