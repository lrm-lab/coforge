import {
  CliError,
  NO_MESSAGE_SENT_NEXT_ACTION,
  unknownDeliveryNextAction,
} from "./cli-error";
import { proxyFailureCode } from "./proxy-failure-code";
import { operationFailedCode, type AgentProxyErrorBody } from "./proxy-request";
import { refusalNextAction } from "./refusal-guidance";

/** `idempotent`: asking again changes nothing (a read), so an upstream 5xx or a transport failure
 * is worth retrying. Off by default: most proxied operations have effects. */
type ProxyFailureOptions = { idempotent?: boolean };

/**
 * Classifies a non-ok proxy response (or a network failure reaching the proxy) into a `CliError`.
 * `send` failures raised here happened AFTER the daemon saved the local draft and handed the
 * request to its transport (see `runtime.ts#sendAgentMessage`): delivery state is unknown, so they
 * are not retryable from this evidence alone (see `cli-error.ts`) — unless the daemon says
 * otherwise: after a failed same-key replay it knows whether the draft still holds the key.
 */
export function proxyHttpFailure(
  operation: string,
  status: number,
  body: { json?: AgentProxyErrorBody },
  target: string | undefined,
  { idempotent = false }: ProxyFailureOptions = {},
): CliError {
  const isSend = operation === "send";
  const proxy = body.json?.proxy;
  const isLocalPrecondition = proxy?.failure_class === "local_precondition";
  // A server refusal names its own next step (`refusal-guidance.ts`).
  const refusalNext =
    proxy?.failure_class === "upstream_refusal"
      ? refusalNextAction(
          operation,
          {
            status: proxy.upstream_status ?? status,
            code: body.json?.code,
            retryable: body.json?.retryable,
          },
          target ?? "",
        )
      : undefined;
  // A local precondition usually means nothing was saved, but a guard that saves a draft before
  // refusing (e.g. --target-confirmed) says so explicitly via `draft_saved`; honour it when present.
  const draftSaved = proxy?.draft_saved !== undefined ? proxy.draft_saved : !isLocalPrecondition;
  const message = body.json?.error || `HTTP ${status}`;
  const code = proxyFailureCode(operation, status, body.json);
  // Any upstream 5xx, including one the daemon relayed with the server's named code.
  const transient =
    code === "SERVER_5XX" ||
    (proxy?.failure_class === "upstream_http_response" &&
      (proxy.upstream_status ?? status) >= 500) ||
    proxy?.failure_class === "pre_response_transport" ||
    proxy?.failure_class === "mid_response_transport";
  return new CliError({
    code,
    message,
    retryable: body.json?.retryable ?? (idempotent && transient),
    ...(isSend ? { draftSaved } : {}),
    correlationId: proxy?.correlation_id,
    proxy: proxy
      ? {
          failureClass: proxy.failure_class,
          causeCode: proxy.cause_code,
          routeFamily: proxy.route_family,
          upstreamLayer: proxy.upstream_layer,
          upstreamStatus: proxy.upstream_status,
          responseStarted: proxy.response_started,
          responseComplete: proxy.response_complete,
        }
      : { upstreamStatus: status },
    // The daemon names the next step when it knows better than the generic line: a precondition
    // with its own remedy, or a failed same-key replay whose draft may or may not be retried. A
    // server refusal names its own.
    suggestedNextAction:
      body.json?.suggested_next_action ??
      refusalNext ??
      (isSend
        ? isLocalPrecondition
          ? NO_MESSAGE_SENT_NEXT_ACTION
          : unknownDeliveryNextAction(target ?? "")
        : undefined),
    ...(body.json?.details ? { details: body.json.details } : {}),
  });
}

/** A failure reaching the local daemon proxy itself (network/timeout): treated conservatively as
 * "may have been issued" — see `unknownDeliveryNextAction`. */
export function proxyTransportFailure(
  operation: string,
  target: string | undefined,
  { idempotent = false }: ProxyFailureOptions = {},
): CliError {
  const isSend = operation === "send";
  return new CliError({
    code: isSend ? "SEND_FAILED" : operationFailedCode(operation),
    message: "agent proxy request failed (network or timeout)",
    retryable: idempotent,
    ...(isSend
      ? { draftSaved: true, suggestedNextAction: unknownDeliveryNextAction(target ?? "") }
      : {}),
  });
}
