import type {
  AgentContextEntry,
  AgentContextReadResponse,
  AgentContextSearchResponse,
} from "@lrm/coforge-sdk/agent";
import type { RestoredContextView } from "./context-view-restore";
import {
  AGENT_CONTEXT_ENTRY_READ_DEFAULT_LIMIT,
  AGENT_CONTEXT_ENTRY_READ_MAX_BYTES,
  AGENT_CONTEXT_ENTRY_READ_MAX_LIMIT,
  AGENT_CONTEXT_ENTRY_READ_PAGE_BYTES,
  AGENT_CONTEXT_ENTRY_SEARCH_DEFAULT_LIMIT,
  AGENT_CONTEXT_ENTRY_SEARCH_MAX_LIMIT,
  AGENT_CONTEXT_ENTRY_SEARCH_MAX_QUERY_CHARS,
} from "@lrm/coforge-sdk/agent";

const SNIPPET_CHARS = 400;

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("context pagination must be a non-negative integer");
  return result;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = [record.text, record.output, record.content, record.input];
    const selected = preferred.map(text).find(Boolean);
    return selected ?? JSON.stringify(value);
  }
  return String(value);
}

function snippet(value: string, query: string): string {
  const lower = value.toLocaleLowerCase();
  const at = lower.indexOf(query.toLocaleLowerCase());
  if (at < 0 || value.length <= SNIPPET_CHARS) return value.slice(0, SNIPPET_CHARS);
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  return value.slice(start, start + SNIPPET_CHARS);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return `${Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes - 1))
    .toString("utf8")}…`;
}

export function contextViewEntries(view: RestoredContextView): AgentContextEntry[] {
  const entries: AgentContextEntry[] = [];
  for (const [index, system] of (view.system ?? []).entries())
    entries.push({ id: `s${index}`, kind: "system", text: text(system.text) });
  for (const [index, tool] of (view.tools ?? []).entries())
    entries.push({
      id: `t${index}`,
      kind: "tool",
      text: [tool.name, tool.description, text(tool.inputSchema)].filter(Boolean).join("\n"),
    });
  for (const [messageIndex, message] of view.messages.entries())
    for (const [partIndex, part] of message.parts.entries())
      entries.push({
        id: `m${messageIndex}.p${partIndex}`,
        kind: "message",
        role: message.role,
        text: text(part),
      });
  return entries;
}

export function searchContextView(
  view: RestoredContextView,
  input: { messageId: string; sessionId: string; query: string; limit?: number; offset?: number },
): AgentContextSearchResponse {
  if (input.query.length === 0 || input.query.length > AGENT_CONTEXT_ENTRY_SEARCH_MAX_QUERY_CHARS)
    throw new Error("context query must be between 1 and 200 characters");
  const limit = Math.min(
    AGENT_CONTEXT_ENTRY_SEARCH_MAX_LIMIT,
    Math.max(1, nonNegativeInteger(input.limit, AGENT_CONTEXT_ENTRY_SEARCH_DEFAULT_LIMIT)),
  );
  const offset = nonNegativeInteger(input.offset, 0);
  const matches = contextViewEntries(view)
    .filter((entry) => entry.text.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      ...(entry.role ? { role: entry.role } : {}),
      snippet: snippet(entry.text, input.query),
    }));
  return {
    ok: true,
    mode: "search",
    messageId: input.messageId,
    sessionId: input.sessionId,
    query: input.query,
    total: matches.length,
    offset,
    limit,
    results: matches.slice(offset, offset + limit),
  };
}

export function readContextView(
  view: RestoredContextView,
  input: { messageId: string; sessionId: string; around: string; limit?: number; page?: number },
): AgentContextReadResponse {
  const entries = contextViewEntries(view);
  const anchor = entries.findIndex((entry) => entry.id === input.around);
  if (anchor < 0) throw new Error("context entry not found");
  const limit = Math.min(
    AGENT_CONTEXT_ENTRY_READ_MAX_LIMIT,
    Math.max(1, nonNegativeInteger(input.limit, AGENT_CONTEXT_ENTRY_READ_DEFAULT_LIMIT)),
  );
  const page = nonNegativeInteger(input.page, 0);
  const start = Math.max(0, anchor - Math.floor(limit / 2)) + page * limit;
  const selected: AgentContextEntry[] = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of entries.slice(start, start + limit)) {
    const nextBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
    const remaining =
      Math.min(AGENT_CONTEXT_ENTRY_READ_PAGE_BYTES, AGENT_CONTEXT_ENTRY_READ_MAX_BYTES) - bytes;
    if (remaining <= 0) break;
    if (nextBytes > remaining) {
      const textBudget = Math.max(
        0,
        remaining - Buffer.byteLength(JSON.stringify({ ...entry, text: "" }), "utf8") - 512,
      );
      selected.push({ ...entry, text: truncateUtf8(entry.text, textBudget) });
      truncated = true;
      break;
    }
    selected.push(entry);
    bytes += nextBytes;
  }
  return {
    ok: true,
    mode: "read",
    messageId: input.messageId,
    sessionId: input.sessionId,
    around: input.around,
    page,
    limit,
    entries: selected,
    hasMore: truncated || start + selected.length < entries.length,
  };
}
