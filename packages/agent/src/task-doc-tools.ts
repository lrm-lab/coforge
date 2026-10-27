/**
 * Eval-only document retrieval for the unfenced Task Agent
 * (bm25-patch-paired-eight-20261017: ov_find moved from the Memory Agent to
 * the Task Agent). Calls the workspace's OpenViking instance directly with the
 * episode account and mirrors the Memory Agent fence tool's model-facing
 * response shape, so BM25 behavior — including the patched 1935 arm — is the
 * only difference. No web citation registration and no per-trigger read
 * budget: those belong to the Memory Agent route this path intentionally
 * bypasses. Enabled only when COFORGE_EVAL_TASK_DOC_TOOLS=1 plus the
 * COFORGE_EVAL_OV_* values below are present in the session environment.
 * Ported into main for the information_retrieval par protocol: the corpus lives in its own OpenViking
 * instance (a task environment, not memory); the Memory Agent only retrieves experience cards.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createMemoryDispositionTool } from "./memory-disposition-tool";

const PROTOCOL = "coforge.openviking.agent.v1";
const EXCERPT_CAP = 480;

type TaskDocEnv = {
  baseUrl: string;
  accountId: string;
  accountKey: string;
  userId: string;
};

function taskDocEnv(environment: Readonly<Record<string, string>>): TaskDocEnv | undefined {
  if (environment.COFORGE_EVAL_TASK_DOC_TOOLS !== "1") return undefined;
  const baseUrl = environment.COFORGE_EVAL_OV_BASE_URL;
  const accountId = environment.COFORGE_EVAL_OV_ACCOUNT_ID;
  const accountKey = environment.COFORGE_EVAL_OV_ACCOUNT_KEY;
  if (!baseUrl || !accountId || !accountKey) {
    throw new Error("task document tools require COFORGE_EVAL_OV_BASE_URL, _ACCOUNT_ID and _ACCOUNT_KEY");
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    accountId,
    accountKey,
    userId: environment.COFORGE_EVAL_OV_USER ?? `task-agent:${accountId}`,
  };
}

/** Eval-only per-episode document budget. The Memory Agent's per-trigger read
 * budget does not apply on this direct-OV path, and without a cap the Task
 * Agent happily spends the whole 900s episode pivoting queries (smoke 3:
 * 106 finds, zero messages). Overflow returns a terminal instruction, not a
 * silent failure, so the model is forced into answering. */
class DocumentBudget {
  #finds = 0;
  #reads = 0;
  constructor(
    readonly findCap: number | undefined,
    readonly readCap: number | undefined,
  ) {}
  consume(kind: "find" | "read"): string | undefined {
    if (kind === "find") {
      this.#finds += 1;
      if (this.findCap !== undefined && this.#finds > this.findCap) {
        return `document_budget_exhausted: ov_find budget (${this.findCap}) is exhausted for this episode. Do not search again. Synthesize your best final answer and PUBLISH it now to the group channel with \`coforge message send\` (heredoc form, target from the trigger notice) in the required Explanation/Exact Answer/Confidence format; text written without sending is not delivered.`;
      }
      return undefined;
    }
    this.#reads += 1;
    if (this.readCap !== undefined && this.#reads > this.readCap) {
      return `document_budget_exhausted: ov_read budget (${this.readCap}) is exhausted for this episode. Do not read again. Synthesize your best final answer and PUBLISH it now to the group channel with \`coforge message send\` (heredoc form, target from the trigger notice) in the required Explanation/Exact Answer/Confidence format; text written without sending is not delivered.`;
    }
    return undefined;
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return parsed > 0 ? parsed : undefined;
}

async function ovFetch(env: TaskDocEnv, method: string, path: string, body?: unknown): Promise<unknown> {
  // 2026-10-17 full65 batch evidence: under OV-side lock contention the fetch can
  // hang indefinitely, wedging the whole task-agent session until the episode
  // deadline. A hard timeout converts that into a recoverable tool error.
  const response = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: env.accountKey.startsWith("Bearer ") ? env.accountKey : `Bearer ${env.accountKey}`,
      "x-openviking-account": env.accountId,
      "x-openviking-user": env.userId,
      "x-openviking-role": "user",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`openviking ${path} failed: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

function citationIdFor(uri: string): string {
  return `ov:${uri.replace(/^viking:\/\/resources\//, "")}`;
}

/** Mirrors MemoryAgentTurnBudget.discoveryView: cap fresh excerpts, omit repeats. */
class DiscoverySnippets {
  #seen = new Set<string>();

  view(items: Array<Record<string, unknown>>): {
    items: Array<Record<string, unknown>>;
    discoveryNotes?: Array<{ citationRef: string; note: string }>;
  } {
    const notes: Array<{ citationRef: string; note: string }> = [];
    const shaped = items.map((item) => {
      const uri = typeof item.uri === "string" ? item.uri : "";
      const excerpt = typeof item.excerpt === "string" ? item.excerpt : "";
      if (uri.startsWith("viking://resources/causal/") || !excerpt) return item;
      const key = JSON.stringify([uri, item.contentHash ?? null, hashText(excerpt)]);
      const repeated = this.#seen.has(key);
      this.#seen.add(key);
      if (!repeated && excerpt.length <= EXCERPT_CAP) return item;
      notes.push({
        citationRef: citationIdFor(uri),
        note: repeated
          ? "Previously discovered snippet omitted. Use ov_read with this URI to verify the full document; omission is not evidence of absence."
          : "Discovery excerpt shortened. Use ov_read with this URI for full text before treating missing details as absent.",
      });
      return { ...item, excerpt: repeated ? "" : excerpt.slice(0, EXCERPT_CAP) };
    });
    return notes.length ? { items: shaped, discoveryNotes: notes } : { items: shaped };
  }
}

function hashText(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function navigationFrom(
  lexical: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (typeof lexical.chain_ref !== "string") return undefined;
  const allowed = new Set(items.map((item) => String(item.uri)));
  const resources = Array.isArray(lexical.resources) ? lexical.resources : [];
  return {
    mode: "bm25",
    chainRef: lexical.chain_ref,
    step: lexical.step,
    remainingHops: lexical.remaining_hops,
    exhausted: lexical.exhausted,
    nodes: resources
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && allowed.has(String((row as Record<string, unknown>).uri)))
      .map((row) => {
        const metadata = (row.metadata ?? {}) as Record<string, unknown>;
        return {
          uri: row.uri,
          kind: metadata.kind ?? "document",
          status: metadata.status,
          sourceRef: metadata.source_ref,
          relations: metadata.relations ?? [],
        };
      }),
  };
}

/** ov_find + ov_read for the Task Agent; empty when the eval env is absent. */
export function createTaskDocTools(environment: Readonly<Record<string, string>>): ReturnType<typeof defineTool>[] {
  const env = taskDocEnv(environment);
  if (!env) return [];
  const snippets = new DiscoverySnippets();
  const budget = new DocumentBudget(
    positiveInt(environment.COFORGE_EVAL_TASK_FIND_CAP),
    positiveInt(environment.COFORGE_EVAL_TASK_READ_CAP),
  );

  const find = defineTool({
    name: "ov_find",
    label: "OpenViking find",
    description:
      "Search this workspace's document memory with BM25. Queries are OR-matched word searches: quotation marks do not enforce phrases and date ranges are not filters. Prefer short distinctive clue queries; read promising returned document URIs with ov_read before more keyword variants; verify constraints in document text and pivot using actual candidate entities. All arguments go in the arguments JSON; an empty object is invalid. " +
      "所有参数必须放进 arguments JSON，不能空对象。",
    parameters: Type.Object({
      operationId: Type.String({
        description:
          "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: find-1. Use a fresh id for each new logical operation or changed arguments; preserve the id only for an identical retry.",
      }),
      query: Type.String({ description: "Required. Search text. Example: deploy rollback." }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "Optional. Integer from 1 to 10. Example: 10." }),
      ),
      targetUri: Type.Optional(
        Type.String({ description: "Optional. URI scope. Omit to search the whole workspace. Example: viking://workspace/docs." }),
      ),
    }),
    prepareArguments: (args) => {
      const record = args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
      if (typeof record.limit === "string" && /^\d+$/.test(record.limit)) record.limit = Number(record.limit);
      if (typeof record.targetUri === "string" && /^viking:\/\/\s*$/.test(record.targetUri)) delete record.targetUri;
      if (Object.keys(record).length === 0)
        throw new Error("invalid ov_find arguments: missing query. Example: {\"operationId\":\"find-1\",\"query\":\"deploy rollback\"}.");
      return record as never;
    },
    execute: async (_toolCallId, params) => {
      const request = params as { operationId: string; query: string; limit?: number; targetUri?: string };
      const exhausted = budget.consume("find");
      if (exhausted) return toolResult({ error: exhausted });
      const payload = (await ovFetch(env, "POST", "/api/v1/search/find", {
        query: request.query,
        retrieval_mode: "bm25",
        limit: request.limit ?? 10,
        ...(request.targetUri === undefined ? {} : { target_uri: request.targetUri }),
      })) as Record<string, unknown>;
      const lexical =
        payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? (payload.result as Record<string, unknown>)
          : {};
      if (lexical.retrieval_mode !== "bm25") throw new Error("bm25_backend_required");
      const resources = Array.isArray(lexical.resources) ? (lexical.resources as Record<string, unknown>[]) : [];
      const items = resources.map((hit) => ({
        citationId: citationIdFor(String(hit.uri ?? "")),
        uri: hit.uri,
        contentHash: hit.content_hash,
        matchedLevel: hit.level,
        excerpt: hit.excerpt,
        score: hit.score,
        metadata: hit.metadata ?? {},
      }));
      const viewed = snippets.view(items);
      return toolResult({
        protocol: PROTOCOL,
        op: "find",
        operationId: request.operationId,
        duplicate: false,
        ...viewed,
        ...(navigationFrom(lexical, viewed.items) ? { retrieval: navigationFrom(lexical, viewed.items) } : {}),
      });
    },
  });

  const read = defineTool({
    name: "ov_read",
    label: "OpenViking read",
    description:
      "Read one OpenViking document in full by URI. Document find results are compact discovery cards; repeated snippets may be omitted. Read relevant sources to check unresolved constraints, and before concluding a detail is absent. A short or omitted discovery excerpt is not evidence that the full source lacks the answer. All arguments go in the arguments JSON; an empty object is invalid. " +
      "所有参数必须放进 arguments JSON，不能空对象。",
    parameters: Type.Object({
      operationId: Type.String({
        description:
          "Required. Client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$. Example: read-1. Use a fresh id for each new logical operation or changed arguments; preserve the id only for an identical retry.",
      }),
      uri: Type.String({ description: "Required. Document URI returned by ov_find. Example: viking://resources/wiki/deploy.md." }),
    }),
    prepareArguments: (args) => {
      const record = args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
      if (Object.keys(record).length === 0)
        throw new Error("invalid ov_read arguments: missing uri. Example: {\"operationId\":\"read-1\",\"uri\":\"viking://resources/wiki/deploy.md\"}.");
      return record as never;
    },
    execute: async (_toolCallId, params) => {
      const request = params as { operationId: string; uri: string };
      const exhausted = budget.consume("read");
      if (exhausted) return toolResult({ error: exhausted });
      const payload = (await ovFetch(
        env,
        "GET",
        `/api/v1/content/read?uri=${encodeURIComponent(request.uri)}`,
      )) as Record<string, unknown>;
      // The content route returns the document text as a bare string.
      const result =
        payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? (payload.result as Record<string, unknown>)
          : {};
      const content = typeof payload.result === "string" ? payload.result : result.content;
      return toolResult({
        protocol: PROTOCOL,
        op: "read",
        operationId: request.operationId,
        duplicate: false,
        citation: {
          citationId: citationIdFor(request.uri),
          uri: request.uri,
          contentHash: result.content_hash,
          matchedLevel: result.level,
        },
        content,
      });
    },
  });

  return [find, read];
}

/** The Task Agent's standing eval tools: the Memory Hint receipt, plus document retrieval when enabled. */
export function taskAgentTools(
  proxy: Parameters<typeof createMemoryDispositionTool>[0],
  sessionEnvironment: Readonly<Record<string, string>> | undefined,
  options: { memoryControlSession?: boolean } = {},
) {
  const env = Object.fromEntries(
    Object.entries({ ...Bun.env, ...sessionEnvironment }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return [
    createMemoryDispositionTool(proxy),
    ...(options.memoryControlSession ? [] : createTaskDocTools(env)),
  ];
}
