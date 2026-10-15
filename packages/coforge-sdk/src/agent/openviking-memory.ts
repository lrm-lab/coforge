/**
 * Agent-facing OpenViking reads and server-owned memory control commands.
 *
 * Framework-free JSON that travels Agent → local Daemon proxy → Web gateway.
 * Tenant credentials never appear here. The Memory Agent may find, expand
 * hierarchical context, read, offer, or request scoped diagnosis; it cannot write files, commit sessions,
 * or mutate skills or ACLs.
 */

import { decodeOpenVikingCitation, type OpenVikingCitation } from "./memory-citations";

export const OPENVIKING_AGENT_PROTOCOL = "coforge.openviking.agent.v1" as const;

/** Fenced runtime tool-profile kind. Distinct from Workspace Memory Profile persistence. */
export const OPENVIKING_TOOL_PROFILE = "openviking-memory" as const;

export const MEMORY_READ_BUDGET_PER_TRIGGER = 3 as const;
export const MEMORY_OFFER_BUDGET_PER_TRIGGER = 1 as const;
export const OPENVIKING_CANDIDATE_LIMIT_MAX = 10 as const;

export const OPENVIKING_AGENT_OPERATIONS = [
  "find",
  "search_context",
  "read",
  "expand",
  "offer",
  "diagnose",
] as const;

export type OpenVikingAgentOperation = (typeof OPENVIKING_AGENT_OPERATIONS)[number];

export const OPENVIKING_AGENT_READ_OPERATIONS = [
  "find",
  "search_context",
  "read",
  "expand",
] as const;
export type OpenVikingAgentReadOperation = (typeof OPENVIKING_AGENT_READ_OPERATIONS)[number];

/** Native tool names on the fenced OpenViking Memory Agent profile (plus channel message I/O). */
export const OPENVIKING_TOOL_NAMES = {
  find: "ov_find",
  searchContext: "ov_search_context",
  read: "ov_read",
  expand: "ov_expand",
  offer: "memory_offer",
  diagnose: "memory_diagnose",
} as const;

export const OPENVIKING_AGENT_ERROR_CODES = [
  "openviking-request-invalid",
  "openviking-unauthorized",
  "openviking-citation-ungrounded",
  "openviking-budget-exhausted",
  "openviking-runtime-unavailable",
  "openviking-duplicate-conflict",
] as const;
export type OpenVikingAgentErrorCode = (typeof OPENVIKING_AGENT_ERROR_CODES)[number];

export type OpenVikingFindCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "find";
  operationId: string;
  query: string;
  limit?: number;
  targetUri?: string;
};

export type OpenVikingSearchContextCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "search_context";
  operationId: string;
  query: string;
  limit?: number;
  targetUri?: string;
  tokenBudget?: number;
};

export type OpenVikingReadCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "read";
  operationId: string;
  uri: string;
};

export const OPENVIKING_GRAPH_RELATIONS = [
  "incoming",
  "outgoing",
  "source",
  "target",
  "forks",
  "anchor",
  "branch_steps",
  "next",
  "previous",
  "observed_block",
] as const;
export type OpenVikingGraphRelation = (typeof OPENVIKING_GRAPH_RELATIONS)[number];
export type OpenVikingExpandCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "expand";
  operationId: string;
  chainRef: string;
  uri: string;
  relation: OpenVikingGraphRelation;
  limit?: number;
};

export type OpenVikingOfferCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  conversationId?: string;
  targetAgentId?: string;
  recipientRationale?: string;
  citationRefs: string[];
  body: string;
};

export type OpenVikingDiagnoseCommand = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "diagnose";
  operationId: string;
  messageId: string;
};

export type OpenVikingDiagnoseResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "diagnose";
  operationId: string;
  duplicate: boolean;
  status: "running" | "completed" | "failed";
  published: boolean;
  reason?: string;
  messageId?: string;
};

export type OpenVikingAgentCommand =
  | OpenVikingFindCommand
  | OpenVikingSearchContextCommand
  | OpenVikingReadCommand
  | OpenVikingExpandCommand
  | OpenVikingOfferCommand
  | OpenVikingDiagnoseCommand;

export type OpenVikingRetrieval = {
  mode: "bm25";
  chainRef: string;
  step: number;
  remainingHops: number;
  exhausted: boolean;
  nodes: Array<{
    uri: string;
    kind: string;
    status?: string;
    sourceRef?: string;
    relations: OpenVikingGraphRelation[];
  }>;
};

export type OpenVikingFindResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "find";
  operationId: string;
  duplicate: boolean;
  items: OpenVikingCitation[];
  retrieval?: OpenVikingRetrieval;
};

export type OpenVikingSearchContextResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "search_context";
  operationId: string;
  duplicate: boolean;
  items: OpenVikingCitation[];
};

export type OpenVikingReadResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "read";
  operationId: string;
  duplicate: boolean;
  citation: OpenVikingCitation;
  content: string;
};

export type OpenVikingExpandResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "expand";
  operationId: string;
  duplicate: boolean;
  items: OpenVikingCitation[];
  retrieval?: OpenVikingRetrieval;
};

export type OpenVikingOfferResponse = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  op: "offer";
  operationId: string;
  published: boolean;
  duplicate: boolean;
  messageId?: string;
  recipientAgentId?: string;
  citations: OpenVikingCitation[];
};

export type OpenVikingAgentError = {
  protocol: typeof OPENVIKING_AGENT_PROTOCOL;
  operationId?: string;
  error: {
    code: OpenVikingAgentErrorCode;
    message: string;
  };
};

export type OpenVikingAgentResponse =
  | OpenVikingFindResponse
  | OpenVikingSearchContextResponse
  | OpenVikingReadResponse
  | OpenVikingExpandResponse
  | OpenVikingOfferResponse
  | OpenVikingDiagnoseResponse;

/** Client-invented idempotency handle. Same pattern the server rejects with 400. */
export const OPENVIKING_OPERATION_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";

/** Copyable rule for models that echo prompt text instead of reading JSON Schema. */
export const OPENVIKING_OPERATION_ID_RULE =
  "operationId is a client-invented idempotency handle matching ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$ (starts with a letter or digit, may contain hyphens and underscores, at most 128 characters). Use a new id on every call.";

/** One complete arguments object per operation. Placeholders are meant to be copied. */
export const OPENVIKING_ARGUMENT_EXAMPLES: Record<OpenVikingAgentOperation, string> = {
  diagnose: '{"operationId":"diagnose-1","messageId":"<求助消息 id>"}',
  find: '{"operationId": "find-1", "query": "<检索词>", "limit": 10}',
  search_context: '{"operationId": "search-1", "query": "<检索词>", "limit": 10}',
  read: '{"operationId": "read-1", "uri": "<document uri>"}',
  expand:
    '{"operationId": "hop-1", "chainRef": "<ov_find chainRef>", "uri": "<served node uri>", "relation": "anchor", "limit": 5}',
  offer:
    '{"operationId": "offer-1", "citationRefs": ["<ov_find 返回的 citation id>"], "body": "<给 @task 的正文>"}',
};

/** Channel fence tools. Not OpenViking commands; kept beside the examples models copy. */
export const CHANNEL_ARGUMENT_EXAMPLES = {
  message_read: '{"target": "#<频道名>"}',
  send_channel_message: '{"target": "#<频道名>", "content": "<正文>"}',
} as const;

export const OPENVIKING_REQUIRED_FIELDS: Record<OpenVikingAgentOperation, readonly string[]> = {
  diagnose: ["operationId", "messageId"],
  find: ["operationId", "query"],
  search_context: ["operationId", "query"],
  read: ["operationId", "uri"],
  expand: ["operationId", "chainRef", "uri", "relation"],
  offer: ["operationId", "citationRefs", "body"],
};

export function isOpenVikingOperationId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(OPENVIKING_OPERATION_ID_PATTERN).test(value);
}

export function isOpenVikingAgentOperation(value: unknown): value is OpenVikingAgentOperation {
  return (
    typeof value === "string" && (OPENVIKING_AGENT_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isOpenVikingAgentReadOperation(
  value: unknown,
): value is OpenVikingAgentReadOperation {
  return (
    typeof value === "string" &&
    (OPENVIKING_AGENT_READ_OPERATIONS as readonly string[]).includes(value)
  );
}

function coerceCitationRefs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

function coerceInteger(value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return value;
}

function optionalCandidateLimit(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const numeric = coerceInteger(value);
  if (
    !Number.isInteger(numeric) ||
    (numeric as number) < 1 ||
    (numeric as number) > OPENVIKING_CANDIDATE_LIMIT_MAX
  )
    throw new Error(`invalid ${label} limit`);
  return numeric as number;
}

function optionalTargetUri(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`invalid ${label} targetUri`);
  return value;
}

function optionalTokenBudget(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const numeric = coerceInteger(value);
  if (!Number.isInteger(numeric) || (numeric as number) < 1)
    throw new Error(`invalid ${label} tokenBudget`);
  return numeric as number;
}

function isMissingText(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function isMissingCitationRefs(value: unknown): boolean {
  const refs = coerceCitationRefs(value);
  return (
    !Array.isArray(refs) ||
    refs.length === 0 ||
    refs.some((id) => typeof id !== "string" || id.length === 0)
  );
}

/** Required arguments that are absent or blank. Present-but-malformed operationId is not "missing". */
export function listMissingOpenVikingFields(
  command: Partial<OpenVikingAgentCommand> & { query?: unknown; uri?: unknown },
): string[] {
  if (!isOpenVikingAgentOperation(command.op)) return [];
  const raw = command as {
    operationId?: unknown;
    query?: unknown;
    uri?: unknown;
    body?: unknown;
    citationRefs?: unknown;
    messageId?: unknown;
    chainRef?: unknown;
    relation?: unknown;
  };
  const missing: string[] = [];
  for (const field of OPENVIKING_REQUIRED_FIELDS[command.op]) {
    if (field === "operationId") {
      if (typeof raw.operationId !== "string" || raw.operationId.trim() === "") missing.push(field);
    } else if (field === "messageId") {
      if (isMissingText(raw.messageId)) missing.push(field);
    } else if (field === "chainRef" || field === "relation") {
      if (isMissingText(raw[field])) missing.push(field);
    } else if (field === "uri") {
      if (typeof raw.uri !== "string" || raw.uri.length === 0) missing.push(field);
    } else if (field === "citationRefs") {
      if (isMissingCitationRefs(raw.citationRefs)) missing.push(field);
    } else if (field === "query" || field === "body") {
      if (isMissingText(field === "query" ? raw.query : raw.body)) missing.push(field);
    }
  }
  return missing;
}

export function formatOpenVikingMissingArgumentsError(
  op: OpenVikingAgentOperation,
  missing: readonly string[],
  operationId?: unknown,
): string {
  const invalidId =
    typeof operationId === "string" &&
    operationId.trim() !== "" &&
    !isOpenVikingOperationId(operationId)
      ? " operationId is present but does not match the rule."
      : "";
  return `invalid openviking ${op}: missing ${missing.join(", ")}.${invalidId} Example: ${OPENVIKING_ARGUMENT_EXAMPLES[op]}. ${OPENVIKING_OPERATION_ID_RULE}`;
}

export function decodeOpenVikingAgentCommand(value: unknown): OpenVikingAgentCommand {
  if (!value || typeof value !== "object") throw new Error("invalid openviking command");
  const command = value as Partial<OpenVikingAgentCommand> & { query?: unknown; uri?: unknown };
  if (command.protocol !== OPENVIKING_AGENT_PROTOCOL)
    throw new Error("invalid openviking protocol");
  if (!isOpenVikingAgentOperation(command.op)) throw new Error("invalid openviking operation");
  const missing = listMissingOpenVikingFields(command);
  if (missing.length > 0)
    throw new Error(
      formatOpenVikingMissingArgumentsError(command.op, missing, command.operationId),
    );
  if (!isOpenVikingOperationId(command.operationId))
    throw new Error(`invalid openviking operationId. ${OPENVIKING_OPERATION_ID_RULE}`);
  const operationId = command.operationId;

  if (command.op === "find") {
    if (typeof command.query !== "string" || command.query.trim() === "")
      throw new Error("invalid openviking find query");
    const limit = optionalCandidateLimit(command.limit, "openviking find");
    const targetUri = optionalTargetUri(command.targetUri, "openviking find");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId,
      query: command.query,
      ...(limit === undefined ? {} : { limit }),
      ...(targetUri === undefined ? {} : { targetUri }),
    };
  }

  if (command.op === "search_context") {
    if (typeof command.query !== "string" || command.query.trim() === "")
      throw new Error("invalid openviking search_context query");
    const limit = optionalCandidateLimit(command.limit, "openviking search_context");
    const targetUri = optionalTargetUri(command.targetUri, "openviking search_context");
    const tokenBudget = optionalTokenBudget(
      (command as Partial<OpenVikingSearchContextCommand>).tokenBudget,
      "openviking search_context",
    );
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId,
      query: command.query,
      ...(limit === undefined ? {} : { limit }),
      ...(targetUri === undefined ? {} : { targetUri }),
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
    };
  }

  if (command.op === "expand") {
    const expand = command as Partial<OpenVikingExpandCommand>;
    if (
      typeof expand.chainRef !== "string" ||
      !expand.chainRef.trim() ||
      expand.chainRef.length > 256 ||
      typeof expand.uri !== "string" ||
      !expand.uri.trim() ||
      !(OPENVIKING_GRAPH_RELATIONS as readonly unknown[]).includes(expand.relation)
    )
      throw new Error("invalid graph expansion");
    const limit = optionalCandidateLimit(expand.limit, "openviking expand");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "expand",
      operationId,
      chainRef: expand.chainRef,
      uri: expand.uri,
      relation: expand.relation!,
      ...(limit === undefined ? {} : { limit }),
    };
  }

  if (command.op === "read") {
    if (typeof command.uri !== "string" || command.uri.length === 0)
      throw new Error("invalid openviking read uri");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId,
      uri: command.uri,
    };
  }

  if (command.op === "diagnose") {
    if (
      typeof command.messageId !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(command.messageId)
    )
      throw new Error("invalid diagnosis messageId");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "diagnose",
      operationId,
      messageId: command.messageId,
    };
  }

  const offer = command as Partial<OpenVikingOfferCommand>;
  if (offer.op !== "offer") throw new Error("invalid openviking offer");
  const conversationId = optionalOfferId(offer.conversationId);
  const targetAgentId = optionalOfferId(offer.targetAgentId);
  const recipientRationale = optionalOfferRationale(offer.recipientRationale);
  const citationRefs = coerceCitationRefs(offer.citationRefs);
  if (
    !Array.isArray(citationRefs) ||
    citationRefs.length === 0 ||
    !citationRefs.every((id) => typeof id === "string" && id.length > 0) ||
    typeof offer.body !== "string" ||
    offer.body.trim() === ""
  )
    throw new Error("invalid openviking offer");
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(targetAgentId === undefined ? {} : { targetAgentId }),
    ...(recipientRationale === undefined ? {} : { recipientRationale }),
    citationRefs,
    body: offer.body,
  };
}

function optionalOfferId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid openviking offer");
  return value;
}

function optionalOfferRationale(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error("invalid openviking offer");
  return value;
}

function decodeOpenVikingCitationList(
  value: unknown,
  label: string,
  enforceCandidateLimit = true,
): OpenVikingCitation[] {
  if (!Array.isArray(value)) throw new Error(`invalid ${label} citations`);
  if (enforceCandidateLimit && value.length > OPENVIKING_CANDIDATE_LIMIT_MAX)
    throw new Error("openviking candidate limit exceeded");
  return value.map(decodeOpenVikingCitation);
}

function decodeRetrieval(value: unknown): OpenVikingRetrieval | undefined {
  if (value === undefined) return undefined;
  const row = value as Partial<OpenVikingRetrieval> | null;
  if (
    !row ||
    row.mode !== "bm25" ||
    typeof row.chainRef !== "string" ||
    !row.chainRef.trim() ||
    row.chainRef.length > 256 ||
    !Number.isInteger(row.step) ||
    row.step! < 0 ||
    !Number.isInteger(row.remainingHops) ||
    row.remainingHops! < 0 ||
    typeof row.exhausted !== "boolean" ||
    !Array.isArray(row.nodes)
  )
    throw new Error("invalid BM25 retrieval navigation");
  const nodes = row.nodes.map((node) => {
    if (
      !node ||
      typeof node.uri !== "string" ||
      typeof node.kind !== "string" ||
      (node.status !== undefined && typeof node.status !== "string") ||
      (node.sourceRef !== undefined && typeof node.sourceRef !== "string") ||
      !Array.isArray(node.relations) ||
      node.relations.some(
        (relation) => !(OPENVIKING_GRAPH_RELATIONS as readonly unknown[]).includes(relation),
      )
    )
      throw new Error("invalid graph navigation node");
    return {
      uri: node.uri,
      kind: node.kind,
      ...(node.status === undefined ? {} : { status: node.status }),
      ...(node.sourceRef === undefined ? {} : { sourceRef: node.sourceRef }),
      relations: [...node.relations],
    };
  });
  return {
    mode: "bm25",
    chainRef: row.chainRef,
    step: row.step!,
    remainingHops: row.remainingHops!,
    exhausted: row.exhausted,
    nodes,
  };
}

export function decodeOpenVikingAgentResponse(
  op: OpenVikingAgentOperation,
  value: unknown,
): OpenVikingAgentResponse {
  if (!value || typeof value !== "object") throw new Error("invalid openviking response");
  const response = value as OpenVikingAgentResponse;
  if (response.protocol !== OPENVIKING_AGENT_PROTOCOL)
    throw new Error("invalid openviking protocol");
  if (response.op !== op) throw new Error("openviking response op mismatch");
  if (!isOpenVikingOperationId(response.operationId))
    throw new Error("invalid openviking operationId");
  if (typeof response.duplicate !== "boolean") throw new Error("invalid openviking duplicate flag");

  if (response.op === "find") {
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "find",
      operationId: response.operationId,
      duplicate: response.duplicate,
      items: decodeOpenVikingCitationList(response.items, "openviking find"),
      ...(response.retrieval === undefined
        ? {}
        : { retrieval: decodeRetrieval(response.retrieval) }),
    };
  }

  if (response.op === "search_context") {
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "search_context",
      operationId: response.operationId,
      duplicate: response.duplicate,
      items: decodeOpenVikingCitationList(response.items, "openviking search_context"),
    };
  }

  if (response.op === "expand")
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "expand",
      operationId: response.operationId,
      duplicate: response.duplicate,
      items: decodeOpenVikingCitationList(response.items, "openviking expand"),
      ...(response.retrieval === undefined
        ? {}
        : { retrieval: decodeRetrieval(response.retrieval) }),
    };

  if (response.op === "read") {
    const read = response as OpenVikingReadResponse;
    if (typeof read.content !== "string") throw new Error("invalid openviking read content");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "read",
      operationId: read.operationId,
      duplicate: read.duplicate,
      citation: decodeOpenVikingCitation(read.citation),
      content: read.content,
    };
  }

  if (response.op === "diagnose") {
    if (
      !["running", "completed", "failed"].includes(response.status) ||
      typeof response.published !== "boolean" ||
      (response.published && response.status !== "completed") ||
      (response.reason !== undefined && typeof response.reason !== "string") ||
      (response.messageId !== undefined && typeof response.messageId !== "string")
    )
      throw new Error("invalid diagnosis response");
    return {
      protocol: OPENVIKING_AGENT_PROTOCOL,
      op: "diagnose",
      operationId: response.operationId,
      duplicate: response.duplicate,
      status: response.status,
      published: response.published,
      ...(response.reason === undefined ? {} : { reason: response.reason }),
      ...(response.messageId === undefined ? {} : { messageId: response.messageId }),
    };
  }

  const offer = response as OpenVikingOfferResponse;
  if (typeof offer.published !== "boolean") throw new Error("invalid openviking offer published");
  if (offer.messageId !== undefined && typeof offer.messageId !== "string")
    throw new Error("invalid openviking offer messageId");
  if (offer.recipientAgentId !== undefined && typeof offer.recipientAgentId !== "string")
    throw new Error("invalid openviking offer recipient");
  return {
    protocol: OPENVIKING_AGENT_PROTOCOL,
    op: "offer",
    operationId: offer.operationId,
    published: offer.published,
    duplicate: offer.duplicate,
    ...(offer.messageId === undefined ? {} : { messageId: offer.messageId }),
    ...(offer.recipientAgentId === undefined ? {} : { recipientAgentId: offer.recipientAgentId }),
    // Offers can cite the union of multiple bounded reads already accepted by the server.
    citations: decodeOpenVikingCitationList(offer.citations, "openviking offer", false),
  };
}

export function isOpenVikingAgentError(value: unknown): value is OpenVikingAgentError {
  if (!value || typeof value !== "object") return false;
  const error = value as OpenVikingAgentError;
  return (
    error.protocol === OPENVIKING_AGENT_PROTOCOL &&
    (error.operationId === undefined || isOpenVikingOperationId(error.operationId)) &&
    !!error.error &&
    (OPENVIKING_AGENT_ERROR_CODES as readonly string[]).includes(error.error.code) &&
    typeof error.error.message === "string"
  );
}
