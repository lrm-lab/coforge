import { createHash } from "node:crypto";
import { redactContextViewValue, type ContextViewRedactionCounts } from "./context-view-redaction";

type JsonRecord = Record<string, unknown>;
type ClaudeRecord = { start: number; value: JsonRecord };
type ClaudeMessage = { role: string; content: unknown };
type ClaudeUsage = Record<string, unknown>;
type ClaudeTokens = { input: number | null; cacheRead: number | null; total: number | null };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as JsonRecord;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function parsedJson(value: unknown): unknown {
  return value ?? null;
}
function viewTokens(usage: ClaudeUsage | undefined): ClaudeTokens {
  if (!usage) return { input: null, cacheRead: null, total: null };
  const input =
    typeof usage.input_tokens === "number" &&
    Number.isSafeInteger(usage.input_tokens) &&
    usage.input_tokens >= 0
      ? usage.input_tokens +
        (typeof usage.cache_creation_input_tokens === "number" &&
        Number.isSafeInteger(usage.cache_creation_input_tokens) &&
        usage.cache_creation_input_tokens >= 0
          ? usage.cache_creation_input_tokens
          : 0)
      : null;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isSafeInteger(usage.cache_read_input_tokens) &&
    usage.cache_read_input_tokens >= 0
      ? usage.cache_read_input_tokens
      : null;
  return { input, cacheRead, total: input === null ? null : input + (cacheRead ?? 0) };
}
function claudeRequestBody(
  params: JsonRecord,
  shape: JsonRecord,
  messages: ClaudeMessage[],
  cacheControl: Array<{ path: Array<string | number>; value: unknown }>,
): JsonRecord {
  // shapeHash identifies the external shape record; it is not an API parameter
  // and therefore must never participate in the request digest.
  const { shapeHash: _shapeHash, ...requestParams } = params;
  const body: JsonRecord = cloneJson({
    ...requestParams,
    system: shape.system,
    tools: shape.tools,
    messages,
  });
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) =>
      isRecord(message) && typeof message.content === "string"
        ? { ...message, content: [{ type: "text", text: message.content }] }
        : message,
    );
  }
  for (const entry of cacheControl) {
    let node: unknown = body;
    for (const key of entry.path) {
      if (Array.isArray(node) && typeof key === "number") node = node[key];
      else if (isRecord(node) && typeof key === "string") node = node[key];
      else {
        node = undefined;
        break;
      }
    }
    if (isRecord(node)) node.cache_control = cloneJson(entry.value);
  }
  return body;
}
export function claudeRequestDigest(
  params: JsonRecord,
  shape: JsonRecord,
  messages: ClaudeMessage[],
  cacheControl: Array<{ path: Array<string | number>; value: unknown }> = [],
): string {
  return hash(claudeRequestBody(params, shape, messages, cacheControl));
}
function contentBlocks(content: unknown): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}
function mergeMessages(messages: ClaudeMessage[]): ClaudeMessage {
  return {
    role: messages[0]?.role ?? "user",
    content: messages.flatMap((message) => contentBlocks(message.content)),
  };
}
function flattenText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
  );
  return texts.length ? texts.join("\n") : null;
}
function mergeAssistant(records: Array<{ value: JsonRecord; order: number }>): ClaudeMessage {
  const ordered = [...records].sort((left, right) => {
    const a =
      typeof left.value.apiBlockIndex === "number"
        ? left.value.apiBlockIndex
        : Number.MAX_SAFE_INTEGER;
    const b =
      typeof right.value.apiBlockIndex === "number"
        ? right.value.apiBlockIndex
        : Number.MAX_SAFE_INTEGER;
    return a - b || left.order - right.order;
  });
  const content: unknown[] = [];
  const toolInputs = new Map<string, unknown>();
  for (const record of ordered) {
    const wire = isRecord(record.value.wireToolInputs) ? record.value.wireToolInputs : undefined;
    if (wire) for (const [id, input] of Object.entries(wire)) toolInputs.set(id, input);
  }
  for (const record of ordered) {
    const message = record.value.message;
    if (!isRecord(message)) continue;
    for (const block of contentBlocks(message.content)) {
      if (
        isRecord(block) &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        toolInputs.has(block.id)
      )
        content.push({ ...block, input: toolInputs.get(block.id) });
      else content.push(block);
    }
  }
  return { role: "assistant", content };
}
function findSendTrigger(
  records: ClaudeRecord[],
  after: number,
  messageId: string,
  response: ClaudeMessage | undefined,
): { toolUseId: string } | undefined {
  if (!response) return undefined;
  const pattern = new RegExp(
    `Message ID: ${messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`,
  );
  for (const record of records) {
    if (record.start < after || record.value.type !== "user") continue;
    const message = record.value.message;
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block) || typeof block.tool_use_id !== "string") continue;
      if (typeof block.content === "string" && pattern.test(block.content))
        return { toolUseId: block.tool_use_id };
      if (
        Array.isArray(block.content) &&
        block.content.some(
          (part) => isRecord(part) && typeof part.text === "string" && pattern.test(part.text),
        )
      )
        return { toolUseId: block.tool_use_id };
    }
  }
  const commandPattern = /\b(?:raft|slock)\s+(?:message\s+send|task\s+reply)\b/;
  for (const block of contentBlocks(response.content)) {
    if (
      isRecord(block) &&
      (block.type === "tool_use" ||
        block.type === "server_tool_use" ||
        block.type === "mcp_tool_use") &&
      typeof block.id === "string" &&
      isRecord(block.input) &&
      typeof block.input.command === "string" &&
      commandPattern.test(block.input.command)
    )
      return { toolUseId: block.id };
  }
  return undefined;
}
function parseRecords(buffer: Buffer, limit: number): ClaudeRecord[] | null {
  const records: ClaudeRecord[] = [];
  let start = 0;
  while (start < Math.min(buffer.length, limit)) {
    const end = buffer.indexOf(10, start);
    const stop = end < 0 ? buffer.length : end;
    if (stop > limit) break;
    if (stop > start) {
      try {
        const value = JSON.parse(buffer.toString("utf8", start, stop)) as unknown;
        if (isRecord(value)) records.push({ start, value });
      } catch {
        return null;
      }
    }
    if (end < 0) break;
    start = end + 1;
  }
  return records;
}

type Request = {
  id: string;
  sessionId?: string;
  base?: string;
  keep: number;
  tail: string[];
  digest?: string;
  params: JsonRecord;
  start: number;
  timestamp?: string;
  shapeHash?: string;
  cacheControl: Array<{ path: Array<string | number>; value: unknown }>;
};

export type ClaudeRestoreResult =
  | {
      ok: true;
      messages: ClaudeMessage[];
      responseFound: boolean;
      digestMatch: boolean | null;
      redactions: ContextViewRedactionCounts;
      trigger?: { toolUseId: string };
      system: Array<{ text: string }>;
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
      compaction: {
        happened: boolean;
        summary?: { kind: "text" | "encrypted"; text?: string } | null;
      };
      usage?: ClaudeUsage;
      tokens: ClaudeTokens;
      unresolvedMessages: number;
      model?: string;
      requestAt?: string;
    }
  | {
      ok: false;
      failure: "not_found" | "context_mismatch" | "newer_session_format" | "read_failed";
    };

export function restoreClaudeSession(input: {
  buffer: Buffer;
  offset: number;
  sessionId: string;
  messageId: string;
}): ClaudeRestoreResult {
  const records = parseRecords(input.buffer, input.offset);
  if (!records || input.offset < 0 || input.offset > input.buffer.length)
    return { ok: false, failure: "read_failed" };
  const requests = new Map<string, Request>();
  const messages = new Map<string, ClaudeMessage>();
  const responses = new Map<string, ClaudeMessage>();
  const responseRecords = new Map<string, Array<{ value: JsonRecord; order: number }>>();
  const responseUsage = new Map<string, ClaudeUsage>();
  const shapes = new Map<string, JsonRecord>();
  const compactBoundaries: number[] = [];
  const compactSummaries: Array<{ start: number; text: string | null }> = [];
  let userRun: ClaudeMessage[] = [];
  let malformedRequest = false;
  const flushUserRun = () => {
    if (!userRun.length) return;
    for (const item of userRun) messages.set(hash(item), item);
    const merged = mergeMessages(userRun);
    messages.set(hash(merged), merged);
    userRun = [];
  };
  for (const record of records) {
    const value = record.value;
    if (value.type === "unknown_future") return { ok: false, failure: "newer_session_format" };
    const recordSession = str(value.sessionId) ?? str(value.session_id);
    if (recordSession && recordSession !== input.sessionId)
      return { ok: false, failure: "context_mismatch" };
    if (value.type === "api-request") {
      const id = str(value.id);
      if (!id) continue;
      requests.set(id, {
        id,
        sessionId: recordSession,
        base: str(value.base),
        keep:
          typeof value.keep === "number" && Number.isSafeInteger(value.keep) && value.keep >= 0
            ? value.keep
            : 0,
        tail: Array.isArray(value.tail)
          ? value.tail.filter((item): item is string => typeof item === "string")
          : [],
        digest: str(value.requestDigest),
        params: isRecord(value.params) ? value.params : {},
        start: record.start,
        timestamp: str(value.timestamp),
        shapeHash: str(value.shapeHash),
        cacheControl: Array.isArray(value.cacheControl)
          ? value.cacheControl.flatMap((item) =>
              isRecord(item) && Array.isArray(item.path)
                ? [
                    {
                      path: item.path.filter(
                        (part): part is string | number =>
                          typeof part === "string" || typeof part === "number",
                      ),
                      value: item.value,
                    },
                  ]
                : [],
            )
          : [],
      });
      if (
        value.keep !== undefined &&
        (typeof value.keep !== "number" || !Number.isSafeInteger(value.keep) || value.keep < 0)
      )
        malformedRequest = true;
      if (
        value.tail !== undefined &&
        (!Array.isArray(value.tail) || value.tail.some((item) => typeof item !== "string"))
      )
        malformedRequest = true;
      if (
        value.cacheControl !== undefined &&
        (!Array.isArray(value.cacheControl) ||
          value.cacheControl.some(
            (item) =>
              !isRecord(item) ||
              !Array.isArray(item.path) ||
              item.path.length === 0 ||
              item.path.some((part) => typeof part !== "string" && typeof part !== "number"),
          ))
      )
        malformedRequest = true;
    } else if (
      value.type === "api-request-shape" &&
      typeof value.shapeHash === "string" &&
      isRecord(value.shape)
    )
      shapes.set(value.shapeHash, value.shape);
    else if (
      value.type === "api-request-blob" &&
      typeof value.hash === "string" &&
      isRecord(value.message) &&
      typeof value.message.role === "string"
    ) {
      const blob = value.message as ClaudeMessage;
      messages.set(value.hash, blob);
    } else if (
      value.type === "assistant" &&
      isRecord(value.message) &&
      typeof value.message.role === "string"
    ) {
      flushUserRun();
      const ref = str(value.requestRef);
      if (ref) {
        const list = responseRecords.get(ref) ?? [];
        list.push({ value, order: list.length });
        responseRecords.set(ref, list);
        if (isRecord(value.message.usage)) responseUsage.set(ref, value.message.usage);
      } else {
        const item = value.message as ClaudeMessage;
        messages.set(hash(item), item);
      }
    } else if (
      value.type === "user" &&
      isRecord(value.message) &&
      typeof value.message.role === "string"
    ) {
      userRun.push(value.message as ClaudeMessage);
      if (value.isCompactSummary === true)
        compactSummaries.push({
          start: record.start,
          text: flattenText(value.message.content),
        });
    } else if (value.type === "system" && value.subtype === "compact_boundary") {
      compactBoundaries.push(record.start);
    }
  }
  flushUserRun();
  for (const [ref, list] of responseRecords) responses.set(ref, mergeAssistant(list));
  if (malformedRequest) return { ok: false, failure: "read_failed" };
  const target = [...requests.values()].filter((request) => request.start < input.offset).at(-1);
  if (!target) return { ok: false, failure: "not_found" };
  const chain: Request[] = [];
  const seen = new Set<string>();
  let current: Request | undefined = target;
  while (current) {
    if (seen.has(current.id)) return { ok: false, failure: "context_mismatch" };
    seen.add(current.id);
    chain.push(current);
    current = current.base ? requests.get(current.base) : undefined;
    if (chain.at(-1)?.base && !current) return { ok: false, failure: "context_mismatch" };
  }
  let restored: (ClaudeMessage | null)[] = [];
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const request = chain[index]!;
    const next = request.base ? restored.slice(0, request.keep) : [];
    restored = next.concat(request.tail.map((tail) => messages.get(tail) ?? null));
  }
  const unresolved = restored.filter((entry): entry is null => entry === null).length;
  const resolved = restored.map(
    (entry) =>
      entry ?? {
        role: "user",
        content: "[This message is not in the session file and could not be restored.]",
      },
  );
  const response = responses.get(target.id);
  const output = response ? [...resolved, response] : resolved;
  const redactions = { media: 0, diagnostic: 0 };
  const redacted = output.map((entry) => ({
    role: entry!.role,
    content: redactContextViewValue(entry!.content, redactions),
  }));
  const shapeHash = target.shapeHash;
  const shape = shapeHash ? shapes.get(shapeHash) : undefined;
  if (shapeHash && !shape) return { ok: false, failure: "read_failed" };
  const body = shape
    ? claudeRequestBody(target.params, shape, resolved, target.cacheControl)
    : undefined;
  const digestMatch = target.digest
    ? unresolved > 0
      ? false
      : body
        ? target.digest === hash(body)
        : null
    : null;
  const trigger = findSendTrigger(records, target.start, input.messageId, response);
  const system =
    typeof shape?.system === "string"
      ? [{ text: shape.system }]
      : Array.isArray(shape?.system)
        ? shape.system.flatMap((item) =>
            isRecord(item) && typeof item.text === "string" ? [{ text: item.text }] : [],
          )
        : [];
  const tools = Array.isArray(shape?.tools)
    ? shape.tools.flatMap((item) =>
        isRecord(item) && typeof item.name === "string"
          ? [
              {
                name: item.name,
                description: typeof item.description === "string" ? item.description : "",
                inputSchema: parsedJson(item.input_schema),
              },
            ]
          : [],
      )
    : [];
  const redactedSystem = system.map((entry) => ({
    text: String(redactContextViewValue(entry.text, redactions)),
  }));
  const redactedTools = tools.map((tool) => ({
    ...tool,
    description: String(redactContextViewValue(tool.description, redactions)),
    inputSchema: redactContextViewValue(tool.inputSchema, redactions),
  }));
  const summary = compactSummaries.filter((entry) => entry.start < target.start).at(-1);
  const inlineCompaction = output
    .flatMap((entry) => contentBlocks(entry.content))
    .find((part) => isRecord(part) && part.type === "compaction");
  const inlineSummary = isRecord(inlineCompaction)
    ? flattenText(inlineCompaction.content ?? inlineCompaction.text)
    : null;
  const compaction =
    compactBoundaries.some((start) => start < target.start) ||
    summary !== undefined ||
    inlineCompaction !== undefined
      ? {
          happened: true,
          summary: inlineCompaction
            ? inlineSummary === null
              ? { kind: "encrypted" as const }
              : { kind: "text" as const, text: inlineSummary }
            : summary?.text === null
              ? { kind: "encrypted" as const }
              : summary?.text !== undefined
                ? { kind: "text" as const, text: summary.text }
                : null,
        }
      : { happened: false };
  const redactedCompaction =
    compaction.summary?.kind === "text"
      ? {
          ...compaction,
          summary: {
            kind: "text" as const,
            text: String(redactContextViewValue(compaction.summary.text, redactions)),
          },
        }
      : compaction;
  return {
    ok: true,
    messages: redacted,
    responseFound: Boolean(response),
    digestMatch,
    redactions,
    system: redactedSystem,
    tools: redactedTools,
    compaction: redactedCompaction,
    ...(responseUsage.get(target.id) ? { usage: responseUsage.get(target.id) } : {}),
    tokens: viewTokens(responseUsage.get(target.id)),
    unresolvedMessages: unresolved,
    ...(trigger ? { trigger } : {}),
    model: typeof target.params.model === "string" ? target.params.model : undefined,
    requestAt: target.timestamp,
  };
}
