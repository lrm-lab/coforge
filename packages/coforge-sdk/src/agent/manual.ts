/**
 * Wire contract for `coforge manual get|search`, CoForge's server-served Agent Manual.
 * Response fields: `docId`, `topicOrPath`, `docVersion`, `docState`, `contentType`, `content`,
 * and `results` with `slug`/`title`/`firstScreen`. The routes are named `manual`; only the error
 * codes keep a `knowledge_` prefix.
 */

import { z } from "zod";

export type AgentManualGetRequest = {
  topic: string;
  intent: string;
  reason: string;
};

export type AgentManualSearchRequest = {
  query: string;
  intent: string;
  reason: string;
};

export type AgentManualDocState = "published";

/** Response for `GET /api/agent/v1/manual`. */
export type AgentManualGetResponse = {
  ok: true;
  docId: string;
  topicOrPath: string;
  docVersion: string;
  docState: AgentManualDocState;
  contentType: "text/markdown";
  content: string;
};

export type AgentManualSearchResult = {
  slug: string;
  title: string;
  firstScreen: string;
};

/** Response for `GET /api/agent/v1/manual/search`. `scope` is always `null` in v1, since CoForge
 * does not implement a `--scope recipes` filter. */
export type AgentManualSearchResponse = {
  ok: true;
  query: string;
  scope: null;
  results: AgentManualSearchResult[];
};

export const AGENT_MANUAL_ERROR_CODES = [
  "knowledge_not_found",
  "knowledge_topic_invalid",
  "knowledge_query_invalid",
  "knowledge_intent_invalid",
  "knowledge_reason_invalid",
] as const;
export type AgentManualErrorCode = (typeof AGENT_MANUAL_ERROR_CODES)[number];

/** Error shape for both manual routes (`ok: false`), unlike this repo's other sibling Agent
 * routes. */
export type AgentManualErrorResponse = {
  ok: false;
  errorCode: AgentManualErrorCode;
  error: string;
};

const manualErrorResponseSchema = z.object({
  ok: z.literal(false),
  errorCode: z.enum(AGENT_MANUAL_ERROR_CODES),
  error: z.string(),
});

const manualGetResponseSchema = z.object({
  ok: z.literal(true),
  docId: z.string(),
  topicOrPath: z.string(),
  docVersion: z.string(),
  docState: z.literal("published"),
  contentType: z.literal("text/markdown"),
  content: z.string(),
});

const manualSearchResultSchema = z.looseObject({
  slug: z.string(),
  title: z.string(),
  firstScreen: z.string(),
});

const manualSearchResponseSchema = z.object({
  ok: z.literal(true),
  query: z.string(),
  scope: z.null(),
  results: z.array(manualSearchResultSchema),
});

export function decodeAgentManualErrorResponse(
  value: unknown,
): AgentManualErrorResponse | undefined {
  const parsed = manualErrorResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function decodeAgentManualGetResponse(value: unknown): AgentManualGetResponse {
  const parsed = manualGetResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent Manual get response");
  return parsed.data;
}

export function decodeAgentManualSearchResponse(value: unknown): AgentManualSearchResponse {
  const parsed = manualSearchResponseSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid Agent Manual search response");
  return parsed.data;
}
