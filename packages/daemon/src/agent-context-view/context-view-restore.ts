import { redactContextViewValue, type ContextViewRedactionCounts } from "./context-view-redaction";
import { restoreClaudeSession } from "./claude-session-restore";
import { restoreClaude, restoreCodex } from "./context-view-restore-native";
import { restoreKimi, restorePi } from "./context-view-restore-captured";

export type RestoredContextMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: unknown[];
};
export type RestoredContextView = {
  runtime: "claude" | "codex" | "kimi-sdk" | "pi" | "builtin";
  sessionId: string;
  messageId: string;
  messages: RestoredContextMessage[];
  source: { kind: "native" | "captured"; format: string; version?: string | null };
  model?: string | null;
  requestAt?: string | null;
  verification?: "verified" | "count_matched";
  redactions: ContextViewRedactionCounts;
  responseFound?: boolean;
  digestMatch?: boolean | null;
  system?: Array<{ text: string }>;
  tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  compaction?: {
    happened: boolean;
    summary?: { kind: "text" | "encrypted"; text?: string } | null;
  };
  usage?: Record<string, unknown>;
  tokens?: { input: number | null; cacheRead: number | null; total: number | null };
  trigger?: { toolUseId: string };
  unrestoredMessages?: number;
};
export type ContextViewRestoreFailure =
  | "not_found"
  | "too_large"
  | "not_recorded"
  | "context_mismatch"
  | "media_removed"
  | "unsupported_runtime"
  | "newer_session_format"
  | "read_failed";
export type ContextViewTooLargeCause = "session_file" | "request" | "restore_limit";
export type ContextViewRestoreResult =
  | { ok: true; view: RestoredContextView }
  | { ok: false; failure: ContextViewRestoreFailure; tooLargeCause?: ContextViewTooLargeCause };

export type RecordValue = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseRecords(buffer: Buffer, offset: number): RecordValue[] | null | "too_many" {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length) return null;
  const records: RecordValue[] = [];
  let start = 0;
  while (start < Math.min(offset, buffer.length)) {
    const end = buffer.indexOf(10, start);
    const stop = end < 0 ? Math.min(offset, buffer.length) : Math.min(end, offset);
    if (stop > start) {
      try {
        const value = JSON.parse(buffer.toString("utf8", start, stop)) as unknown;
        if (isRecord(value)) records.push(value);
      } catch {
        return null;
      }
    }
    if (records.length > 10_000) return "too_many";
    if (end < 0 || end >= offset) break;
    start = end + 1;
  }
  return records;
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
export function claudeViewParts(content: unknown): unknown[] {
  const blocks =
    typeof content === "string"
      ? [{ type: "text", text: content }]
      : Array.isArray(content)
        ? content
        : [];
  return blocks.flatMap((block): unknown[] => {
    if (typeof block === "string") return [{ kind: "text", text: block }];
    if (!isRecord(block)) return [];
    const type = block.type;
    if (type === "text")
      return [{ kind: "text", text: typeof block.text === "string" ? block.text : "" }];
    if (type === "thinking")
      return [
        { kind: "thinking", text: typeof block.thinking === "string" ? block.thinking : null },
      ];
    if (type === "redacted_thinking") return [{ kind: "thinking", text: null }];
    if (type === "compaction")
      return [
        { kind: "compaction", text: typeof block.content === "string" ? block.content : null },
      ];
    if (type === "image")
      return [
        {
          kind: "image",
          mediaType:
            isRecord(block.source) && typeof block.source.media_type === "string"
              ? block.source.media_type
              : null,
          sizeBytes: null,
        },
      ];
    if (
      typeof type === "string" &&
      (type === "tool_use" || type === "server_tool_use" || type.endsWith("_tool_use"))
    )
      return [
        {
          kind: "tool_use",
          toolName: typeof block.name === "string" ? block.name : "unknown",
          toolUseId: typeof block.id === "string" ? block.id : null,
          input: block.input ?? null,
        },
      ];
    if (typeof type === "string" && (type === "tool_result" || type.endsWith("_tool_result")))
      return [
        {
          kind: "tool_result",
          toolName: null,
          toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
          output:
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? ""),
          isError: block.is_error === true,
        },
      ];
    return [{ kind: "text", text: `[${typeof type === "string" ? type.slice(0, 64) : "block"}]` }];
  });
}
export function sessionMatches(record: RecordValue, sessionId: string): boolean {
  for (const key of ["sessionId", "session_id", "thread_id", "threadId"]) {
    const value = record[key];
    if (typeof value === "string" && value !== sessionId) return false;
  }
  return true;
}
export function providerPayload(record: RecordValue): RecordValue {
  return isRecord(record.payload) ? { ...record.payload, ...record, type: record.type } : record;
}
export function hasNestedIdentityConflict(record: RecordValue): boolean {
  if (!isRecord(record.payload)) return false;
  for (const key of ["sessionId", "session_id", "thread_id", "threadId"]) {
    const outer = record[key];
    const inner = record.payload[key];
    if (typeof outer === "string" && typeof inner === "string" && outer !== inner) return true;
  }
  return false;
}
export function hasHashMismatch(record: RecordValue): boolean {
  const expected = record.expectedHash ?? record.expected_hash;
  const actual = record.hash;
  return typeof expected === "string" && typeof actual === "string" && expected !== actual;
}
export function hasMessageId(record: RecordValue, messageId: string): boolean {
  for (const key of ["messageId", "message_id", "id"]) {
    if (record[key] === messageId) return true;
  }
  if (Array.isArray(record.messageIds) && record.messageIds.includes(messageId)) return true;
  const escaped = messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`).test(JSON.stringify(record));
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
  return {
    ok: true,
    view,
  };
}

export type RestoreRequest = {
  runtime: RestoredContextView["runtime"];
  sessionId: string;
  messageId: string;
  buffer: Buffer;
  offset: number;
  maxBytes?: number;
};

export function restoreContextView(request: RestoreRequest): ContextViewRestoreResult {
  const records = parseRecords(request.buffer, request.offset);
  if (records === "too_many")
    return { ok: false, failure: "too_large", tooLargeCause: "restore_limit" };
  if (!records) return { ok: false, failure: "read_failed" };
  switch (request.runtime) {
    case "claude":
      return restoreClaude(records, request);
    case "codex":
      return restoreCodex(records, request);
    case "kimi-sdk":
      return restoreKimi(records, request);
    case "pi":
    case "builtin":
      return restorePi(records, request);
  }
}
