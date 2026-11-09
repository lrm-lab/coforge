import { redactContextViewValue } from "./context-view-redaction";
import type {
  RecordValue,
  RestoreRequest,
  RestoredContextMessage,
  RestoredContextView,
  ContextViewRestoreResult,
} from "./context-view-restore";

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function textParts(value: unknown): unknown[] {
  if (typeof value === "string") return [{ kind: "text", text: value }];
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [value];
}

export function message(
  role: RestoredContextMessage["role"],
  content: unknown,
): RestoredContextMessage {
  return { role, parts: textParts(content) };
}

export function sessionMatches(record: RecordValue, sessionId: string): boolean {
  for (const key of ["sessionId", "session_id", "thread_id", "threadId"]) {
    const value = record[key];
    if (typeof value === "string" && value !== sessionId) return false;
  }
  return true;
}

export function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function buildView(
  request: RestoreRequest,
  messages: RestoredContextMessage[],
  format: string,
  verification?: RestoredContextView["verification"],
): ContextViewRestoreResult {
  const redactions = { media: 0, diagnostic: 0 };
  const redacted = messages.map((entry) => ({
    ...entry,
    parts: entry.parts.map((part) => redactContextViewValue(part, redactions)),
  }));
  const view: RestoredContextView = {
    runtime: request.runtime,
    sessionId: request.sessionId,
    messageId: request.messageId,
    messages: redacted,
    source: {
      kind: request.runtime === "pi" || request.runtime === "builtin" ? "captured" : "native",
      format,
    },
    ...(verification ? { verification } : {}),
    redactions,
  };
  if (Buffer.byteLength(JSON.stringify(view), "utf8") > (request.maxBytes ?? 32 * 1024 * 1024))
    return { ok: false, failure: "too_large", tooLargeCause: "request" };
  return { ok: true, view };
}
