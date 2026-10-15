/**
 * Memory Agent OpenViking reads. Hits become OpenVikingCitation records;
 * this module never writes OpenViking and never holds OpenViking HTTP paths.
 */

import {
  decodeOpenVikingAgentResponse,
  OPENVIKING_AGENT_PROTOCOL,
  OPENVIKING_CANDIDATE_LIMIT_MAX,
  type OpenVikingRetrieval,
  type OpenVikingGraphRelation,
  type OpenVikingCitation,
} from "@lrm/coforge-sdk/agent";
import {
  MemoryCitationUngroundedError,
  type MemoryCitationBindings,
} from "../workspace-memory/memory-citations";
import {
  assertDiscoveryServable,
  isRetiredFromMemoryDiscovery,
} from "../workspace-memory/memory-discovery-eligibility";
import type { OpenVikingMemoryReadClient } from "./memory-agent-reads";

export { MemoryAgentMutationError } from "./memory-agent-reads";
export type { OpenVikingMemoryReadClient } from "./memory-agent-reads";

export class MemoryReadCapabilityError extends Error {}

export type OpenVikingMemoryQueryResult = {
  items: OpenVikingCitation[];
  retrieval?: OpenVikingRetrieval;
};

export type OpenVikingMemoryReads = {
  expand(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    chainRef: string;
    uri: string;
    relation: OpenVikingGraphRelation;
    limit?: number;
  }): Promise<OpenVikingMemoryQueryResult>;
  find(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    query: string;
    limit?: number;
    targetUri?: string;
  }): Promise<OpenVikingMemoryQueryResult>;
  searchContext(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    query: string;
    limit?: number;
    targetUri?: string;
    tokenBudget?: number;
  }): Promise<OpenVikingCitation[]>;
  read(input: {
    workspaceId: string;
    agentId: string;
    operationId: string;
    uri: string;
  }): Promise<{ citation: OpenVikingCitation; content: string }>;
};

export function createOpenVikingMemoryReads(deps: {
  client: OpenVikingMemoryReadClient;
  citations: MemoryCitationBindings;
}): OpenVikingMemoryReads {
  return {
    async find(input) {
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "find",
        body: {
          query: input.query,
          retrieval_mode: "bm25",
          limit: input.limit ?? OPENVIKING_CANDIDATE_LIMIT_MAX,
          ...(input.targetUri === undefined ? {} : { target_uri: input.targetUri }),
        },
      });
      const envelope =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const lexical =
        envelope.result && typeof envelope.result === "object"
          ? (envelope.result as Record<string, unknown>)
          : envelope;
      if (lexical.retrieval_mode !== "bm25")
        throw new MemoryReadCapabilityError("bm25_backend_required");
      const items = await deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        publicHits(payload, input.workspaceId),
      );
      return { items, ...navigation(lexical, items) };
    },
    async expand(input) {
      await deps.citations.resolveOfferCitations(input.workspaceId, [`ov:${input.uri}`]);
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "expand",
        body: {
          operation_id: input.operationId,
          chain_ref: input.chainRef,
          uri: input.uri,
          relation: input.relation,
          limit: input.limit ?? 10,
        },
      });
      const envelope =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const result =
        envelope.result && typeof envelope.result === "object"
          ? (envelope.result as Record<string, unknown>)
          : envelope;
      if (result.retrieval_mode !== "bm25")
        throw new MemoryReadCapabilityError("bm25_backend_required");
      const items = await deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        publicHits(payload, input.workspaceId),
      );
      return { items, ...navigation(result, items) };
    },

    async searchContext(input) {
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "search_context",
        body: {
          query: input.query,
          limit: input.limit ?? OPENVIKING_CANDIDATE_LIMIT_MAX,
          query_expansion: "off",
          ...(input.targetUri === undefined ? {} : { target_uri: input.targetUri }),
          ...(input.tokenBudget === undefined ? {} : { token_budget: input.tokenBudget }),
        },
      });
      return deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        publicHits(payload, input.workspaceId),
      );
    },

    async read(input) {
      assertDiscoveryServable(input.uri);
      const payload = await deps.client.invoke({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        operation: "read",
        query: { uri: input.uri },
      });
      assertDiscoveryServable(payload);
      const hit = asReadHit(payload, input);
      assertDiscoveryServable(hit);
      const [citation] = await deps.citations.bindOpenVikingHits(
        input.workspaceId,
        input.operationId,
        [hit],
      );
      if (!citation) throw new MemoryCitationUngroundedError();
      return { citation, content: hit.content };
    },
  };
}

function publicHits(payload: unknown, workspaceId: string): unknown[] {
  return collectHits(payload, workspaceId).filter((hit) => !isRetiredFromMemoryDiscovery(hit));
}

function collectHits(payload: unknown, workspaceId: string): unknown[] {
  const accountId = wrapperAccountId(payload);
  return hitList(payload).map((hit) => normalizeHit(hit, workspaceId, accountId));
}

function wrapperAccountId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const accountId = (payload as { accountId?: unknown }).accountId;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

function hitList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
  if (Array.isArray(record.items)) return record.items;
  const nested = record.result;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const inner = nested as Record<string, unknown>;
    const grouped = ["resources", "memories", "skills", "results", "items"].flatMap((key) =>
      Array.isArray(inner[key]) ? inner[key] : [],
    );
    if (
      "resources" in inner ||
      "memories" in inner ||
      "skills" in inner ||
      "results" in inner ||
      "items" in inner
    )
      return grouped;
  }
  if (Array.isArray(record.resources)) return record.resources;
  return typeof record.uri === "string" ? [payload] : [];
}

function normalizeHit(value: unknown, workspaceId: string, accountId: string | undefined): unknown {
  if (!value || typeof value !== "object") return value;
  const hit = value as Record<string, unknown>;
  const uri = typeof hit.uri === "string" ? hit.uri : undefined;
  const excerpt = firstString(hit.excerpt, hit.abstract, hit.snippet, hit.summary);
  const level = openVikingMatchedLevel(hit.matchedLevel ?? hit.matched_level ?? hit.level);
  const existingHash = firstString(hit.contentHash, hit.content_hash);
  const contentHash = existingHash ?? (uri ? contentSha256(`${uri}\n${excerpt ?? ""}`) : undefined);
  return {
    workspaceId,
    ...hit,
    ...(accountId && hit.accountId === undefined && hit.account_id === undefined
      ? { accountId }
      : {}),
    ...(excerpt === undefined ? {} : { excerpt }),
    ...(level === undefined ? {} : { matchedLevel: level }),
    ...(contentHash === undefined ? {} : { contentHash }),
  };
}

function openVikingMatchedLevel(value: unknown): "L0" | "L1" | "L2" | undefined {
  if (value === "L0" || value === "L1" || value === "L2") return value;
  if (value === 0 || value === "0") return "L0";
  if (value === 1 || value === "1") return "L1";
  if (typeof value === "number" && Number.isInteger(value) && value >= 2) return "L2";
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function asReadHit(
  payload: unknown,
  input: { workspaceId: string; uri: string },
): Record<string, unknown> & { content: string } {
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const content =
    record.status === "ok" && typeof record.result === "string"
      ? record.result
      : typeof record.content === "string"
        ? record.content
        : typeof record.body === "string"
          ? record.body
          : "";
  const uri = typeof record.uri === "string" ? record.uri : input.uri;
  return {
    ...record,
    workspaceId: input.workspaceId,
    uri,
    content,
    contentHash:
      record.contentHash ?? record.content_hash ?? (content ? contentSha256(content) : undefined),
    excerpt: record.excerpt ?? record.snippet ?? record.summary ?? content.slice(0, 200),
    matchedLevel: record.matchedLevel ?? record.matched_level ?? record.level ?? "L2",
    citationId: record.citationId ?? record.citation_id ?? `ov:${uri}`,
  };
}

function contentSha256(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return `sha256:${hasher.digest("hex")}`;
}

function navigation(
  result: Record<string, unknown>,
  items: OpenVikingCitation[],
): { retrieval?: OpenVikingRetrieval } {
  if (result.chain_ref === undefined) return {};
  const resources = Array.isArray(result.resources)
    ? (result.resources as { uri: string; metadata?: Record<string, unknown> }[])
    : [];
  const allowed = new Set(items.map((item) => item.uri));
  const response = decodeOpenVikingAgentResponse("find", {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "find",
    operationId: "navigation",
    duplicate: false,
    items,
    retrieval: {
      mode: "bm25",
      chainRef: result.chain_ref,
      step: result.step,
      remainingHops: result.remaining_hops,
      exhausted: result.exhausted,
      nodes: resources
        .filter((row) => allowed.has(row.uri))
        .map((row) => ({
          uri: row.uri,
          kind: row.metadata?.kind ?? "document",
          status: row.metadata?.status,
          sourceRef: row.metadata?.source_ref,
          relations: row.metadata?.relations ?? [],
        })),
    },
  });
  if (response.op !== "find") throw new Error("invalid navigation response");
  return { retrieval: response.retrieval };
}
