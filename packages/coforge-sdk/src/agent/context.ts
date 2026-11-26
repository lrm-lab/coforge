import { z } from "zod";

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

const nonNegativeSafeInt = z.int().min(0);
const entryKindSchema = z.enum(["system", "tool", "message"]);

const contextEntrySchema = z.looseObject({
  id: z.string(),
  kind: entryKindSchema,
  role: z.string().optional(),
  text: z.string(),
});

const contextSearchResultSchema = z.looseObject({
  id: z.string(),
  kind: entryKindSchema,
  role: z.string().optional(),
  snippet: z.string().max(400),
});

const contextQueryHeaderSchema = z.looseObject({
  ok: z.literal(true),
  mode: z.string(),
  messageId: z.string(),
  sessionId: z.string(),
});

const contextSearchResponseSchema = z.looseObject({
  ok: z.literal(true),
  mode: z.literal("search"),
  messageId: z.string(),
  sessionId: z.string(),
  query: z.string(),
  total: nonNegativeSafeInt,
  offset: nonNegativeSafeInt,
  limit: nonNegativeSafeInt,
  results: z.array(contextSearchResultSchema),
});

const contextReadResponseSchema = z.looseObject({
  ok: z.literal(true),
  mode: z.literal("read"),
  messageId: z.string(),
  sessionId: z.string(),
  around: z.string(),
  page: nonNegativeSafeInt,
  limit: nonNegativeSafeInt,
  entries: z.array(contextEntrySchema),
  hasMore: z.boolean(),
});

export function decodeAgentContextQueryResponse(value: unknown): AgentContextQueryResponse {
  const header = contextQueryHeaderSchema.safeParse(value);
  if (!header.success) throw new Error("invalid Agent context query response");
  if (header.data.mode === "search") {
    const parsed = contextSearchResponseSchema.safeParse(value);
    if (!parsed.success) throw new Error("invalid Agent context search response");
    return parsed.data;
  }
  const parsed = contextReadResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent context query response");
  return parsed.data;
}
