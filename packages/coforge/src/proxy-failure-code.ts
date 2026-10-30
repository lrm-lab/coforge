import { operationFailedCode, type AgentProxyErrorBody } from "./proxy-request";

/** The code a 5xx body named, or undefined for the proxy's own generic marker. */
function namedServerCode(json: AgentProxyErrorBody | undefined) {
  return json?.code && json.code !== "agent_proxy_failed" ? json.code : undefined;
}

/**
 * The typed code an Agent decides on. It follows the proxy's `failure_class`, not the proxy's own
 * HTTP status: a decode failure after an upstream 200 is `INVALID_JSON_RESPONSE`, never
 * `SERVER_5XX`, which is reserved for an upstream that really answered 5xx. A 5xx the server
 * named keeps that server's code, so a refusal reads as its reason rather than a generic failure.
 */
export function proxyFailureCode(
  operation: string,
  status: number,
  json: AgentProxyErrorBody | undefined,
): string {
  const proxy = json?.proxy;
  switch (proxy?.failure_class) {
    case "local_precondition":
      return json?.code ?? operationFailedCode(operation);
    case "protocol_mismatch":
      return "INVALID_JSON_RESPONSE";
    // The server's own stable code when its refusal named one (`DM_PEER_NOT_IN_WORKSPACE`).
    case "upstream_refusal":
      return json?.code ?? operationFailedCode(operation);
    case "upstream_http_response":
      return (proxy?.upstream_status ?? status) >= 500
        ? (namedServerCode(json) ?? "SERVER_5XX")
        : operationFailedCode(operation);
    case "pre_response_transport":
    case "mid_response_transport":
      return operationFailedCode(operation);
    default:
      return status >= 500 ? "SERVER_5XX" : operationFailedCode(operation);
  }
}
