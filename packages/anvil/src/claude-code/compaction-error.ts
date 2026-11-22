import { isHttpErrorStatus, type AgentRuntimeEvent } from "#src/contract";
import { eventTime, nonEmptyString } from "#src/json-record";

export type ClaudeFailureEvent = Extract<AgentRuntimeEvent, { type: "error" }>;

export function describesContextOverflow(message: string): boolean {
  return /\b(?:prompt is too long|input is too long for requested model|conversation too long|context length exceeded|exceeds? the context limit)\b/i.test(
    message,
  );
}

function namesCompactionFailure(message: string): boolean {
  return /\b(?:automatic compaction failed\s*:\s*\S|single exchange\b)/i.test(message);
}

export function isClaudeCompactionOverflow(event: ClaudeFailureEvent): boolean {
  return (
    !event.providerLimit &&
    !event.providerErrorReason &&
    (event.httpStatus === undefined || event.httpStatus === 400 || event.httpStatus === 413) &&
    (event.providerErrorCode === undefined ||
      event.providerErrorCode === "invalid_request" ||
      event.providerErrorCode === "invalid_request_error") &&
    describesContextOverflow(event.message) &&
    !namesCompactionFailure(event.message)
  );
}

export function claudeCompactionFailure(
  result: Readonly<Record<string, unknown>>,
  deferred: ClaudeFailureEvent,
): ClaudeFailureEvent {
  const reportedError = Array.isArray(result.errors)
    ? result.errors.find(isSpecificResultFailure)
    : undefined;
  const details =
    reportedError ?? (isSpecificResultFailure(result.result) ? result.result : undefined);
  const code = nonEmptyString(result.api_error_code) ?? nonEmptyString(result.error);
  const httpStatus = isHttpErrorStatus(result.api_error_status)
    ? result.api_error_status
    : undefined;
  const specificCode =
    code && code !== "invalid_request" && code !== "invalid_request_error" ? code : undefined;
  const specificStatus = httpStatus !== 400 && httpStatus !== 413 ? httpStatus : undefined;
  const reason = specificCode ?? specificStatus;
  if (!details && !reason) return deferred;
  return {
    type: "error",
    message: details ?? `Claude request failed (${reason})`,
    ...(code ? { providerErrorCode: code } : {}),
    ...(httpStatus ? { httpStatus } : {}),
    occurredAt: eventTime(result),
  };
}

function isSpecificResultFailure(message: unknown): message is string {
  return (
    typeof message === "string" &&
    Boolean(message.trim()) &&
    !/^execution failed[.!]?$/i.test(message.trim()) &&
    (!describesContextOverflow(message) || namesCompactionFailure(message))
  );
}
