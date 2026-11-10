export const AGENT_CONTEXT_ENTRY_SEARCH_MAX_QUERY_CHARS = 200;
export const AGENT_CONTEXT_ENTRY_SEARCH_DEFAULT_LIMIT = 20;
export const AGENT_CONTEXT_ENTRY_SEARCH_MAX_LIMIT = 50;
export const AGENT_CONTEXT_ENTRY_READ_DEFAULT_LIMIT = 5;
export const AGENT_CONTEXT_ENTRY_READ_MAX_LIMIT = 21;
export const AGENT_CONTEXT_ENTRY_READ_PAGE_BYTES = 8 * 1024;
export const AGENT_CONTEXT_ENTRY_READ_MAX_BYTES = 64 * 1024;

export type AgentContextEntryKind = "system" | "tool" | "message";

export type AgentContextEntry = Readonly<{
  id: string;
  kind: AgentContextEntryKind;
  role?: string;
  text: string;
}>;

export type AgentContextSearchRequest = Readonly<{
  mode: "search";
  messageId: string;
  sessionId: string;
  query: string;
  limit?: number;
  offset?: number;
}>;

export type AgentContextSearchResponse = Readonly<{
  ok: true;
  mode: "search";
  messageId: string;
  sessionId: string;
  query: string;
  total: number;
  offset: number;
  limit: number;
  results: ReadonlyArray<
    Readonly<Pick<AgentContextEntry, "id" | "kind" | "role"> & { snippet: string }>
  >;
}>;

export type AgentContextReadRequest = Readonly<{
  mode: "read";
  messageId: string;
  sessionId: string;
  around: string;
  limit?: number;
  page?: number;
}>;

export type AgentContextReadResponse = Readonly<{
  ok: true;
  mode: "read";
  messageId: string;
  sessionId: string;
  around: string;
  page: number;
  limit: number;
  entries: ReadonlyArray<AgentContextEntry>;
  hasMore: boolean;
}>;

export type AgentContextQueryResponse = AgentContextSearchResponse | AgentContextReadResponse;

function isEntryKind(value: unknown): value is AgentContextEntryKind {
  return value === "system" || value === "tool" || value === "message";
}

function isEntry(value: unknown): value is AgentContextEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    isEntryKind(entry.kind) &&
    typeof entry.text === "string" &&
    (entry.role === undefined || typeof entry.role === "string")
  );
}

function isSearchResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    isEntryKind(entry.kind) &&
    typeof entry.snippet === "string" &&
    entry.snippet.length <= 400 &&
    (entry.role === undefined || typeof entry.role === "string")
  );
}

export function decodeAgentContextQueryResponse(value: unknown): AgentContextQueryResponse {
  if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true)
    throw new Error("invalid Agent context query response");
  const record = value as Record<string, unknown>;
  if (
    typeof record.mode !== "string" ||
    typeof record.messageId !== "string" ||
    typeof record.sessionId !== "string"
  )
    throw new Error("invalid Agent context query response");
  if (record.mode === "search") {
    if (
      typeof record.query !== "string" ||
      typeof record.total !== "number" ||
      !Number.isSafeInteger(record.total) ||
      record.total < 0 ||
      typeof record.offset !== "number" ||
      !Number.isSafeInteger(record.offset) ||
      record.offset < 0 ||
      typeof record.limit !== "number" ||
      !Number.isSafeInteger(record.limit) ||
      record.limit < 0 ||
      !Array.isArray(record.results)
    )
      throw new Error("invalid Agent context search response");
    if (record.results.some((result) => !isSearchResult(result)))
      throw new Error("invalid Agent context search response");
    return record as unknown as AgentContextSearchResponse;
  }
  if (
    record.mode === "read" &&
    typeof record.around === "string" &&
    typeof record.page === "number" &&
    Number.isSafeInteger(record.page) &&
    record.page >= 0 &&
    typeof record.limit === "number" &&
    Number.isSafeInteger(record.limit) &&
    record.limit >= 0 &&
    Array.isArray(record.entries) &&
    record.entries.every((entry) => isEntry(entry)) &&
    typeof record.hasMore === "boolean"
  )
    return record as unknown as AgentContextReadResponse;
  throw new Error("invalid Agent context query response");
}
