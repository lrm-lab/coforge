import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  LocalSessionEntrySchema,
  LocalSessionExcerptRequestSchema,
  LocalSessionExcerptResultSchema,
  LocalSessionSearchRequestSchema,
  LocalSessionSearchResultSchema,
  LocalSessionTurnSchema,
} from "#src/internal/gen/coforge/rpc/v1/local_session_handoff_pb";
import { RPC_METHODS } from "./rpc-methods";
import { RUNTIME_PROVIDER } from "./runtime-provider";

export const LOCAL_SESSION_HANDOFF_CAPABILITY = "local-session-handoff:v1" as const;
export const LOCAL_SESSION_SEARCH_METHOD = RPC_METHODS.daemonLocalSessionSearch;
export const LOCAL_SESSION_SEARCH_RESULT_METHOD = RPC_METHODS.daemonLocalSessionSearchResult;
export const LOCAL_SESSION_EXCERPT_METHOD = RPC_METHODS.daemonLocalSessionExcerpt;
export const LOCAL_SESSION_EXCERPT_RESULT_METHOD = RPC_METHODS.daemonLocalSessionExcerptResult;

const SEARCH_REQUEST_TYPE = "coforge.rpc.v1.LocalSessionSearchRequest";
const SEARCH_RESULT_TYPE = "coforge.rpc.v1.LocalSessionSearchResult";
const EXCERPT_REQUEST_TYPE = "coforge.rpc.v1.LocalSessionExcerptRequest";
const EXCERPT_RESULT_TYPE = "coforge.rpc.v1.LocalSessionExcerptResult";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MATCH_KINDS = new Set(["recent", "id", "cwd", "content"]);
const STATUSES = new Set(["ok", "not_found", "unavailable"]);
const ROLES = new Set(["user", "assistant"]);
const encoder = new TextEncoder();

/** The runtimes whose local sessions can be handed off, in tab order. */
export const HANDOFF_RUNTIME_PROVIDERS = [
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
] as const;
export type HandoffRuntimeProvider = (typeof HANDOFF_RUNTIME_PROVIDERS)[number];
const PROVIDERS: ReadonlySet<string> = new Set(HANDOFF_RUNTIME_PROVIDERS);
export type LocalSessionMatchKind = "recent" | "id" | "cwd" | "content";
export type LocalSessionExcerptStatus = "ok" | "not_found" | "unavailable";

export type LocalSessionSearchRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  query: string;
};
export type LocalSessionEntry = {
  provider: HandoffRuntimeProvider;
  sessionId: string;
  cwd: string;
  model: string;
  title: string;
  updatedAtMs: number;
  matchKind: LocalSessionMatchKind;
  snippet: string;
};
export type LocalSessionSearchResult = LocalSessionSearchRequest & {
  sessions: LocalSessionEntry[];
  scanComplete: boolean;
  contentSearchComplete: boolean;
};
export type LocalSessionExcerptRequest = Pick<
  LocalSessionSearchRequest,
  "protocolMajor" | "requestId" | "workspaceId" | "computerId"
> & {
  provider: HandoffRuntimeProvider;
  sessionId: string;
  cwd: string;
};
export type LocalSessionTurn = {
  role: "user" | "assistant";
  text: string;
  timestampMs: number;
};
export type LocalSessionExcerptResult = LocalSessionExcerptRequest & {
  status: LocalSessionExcerptStatus;
  model: string;
  updatedAtMs: number;
  initialRequest: string;
  recentTurns: LocalSessionTurn[];
};

function scope(
  value: Pick<
    LocalSessionSearchRequest,
    "protocolMajor" | "requestId" | "workspaceId" | "computerId"
  >,
) {
  if (
    value.protocolMajor !== 1 ||
    !ID.test(value.requestId) ||
    !ID.test(value.workspaceId) ||
    !ID.test(value.computerId)
  )
    throw new Error("Invalid local session request scope");
}

function boundedText(value: string, max: number, label: string, required = false): void {
  if ((required && value.length === 0) || value.length > max || value.includes("\0"))
    throw new Error(`Invalid local session ${label}`);
}

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid local session timestamp");
}

function request(value: LocalSessionSearchRequest): void {
  scope(value);
  boundedText(value.query, 200, "query");
}

function entry(value: LocalSessionEntry): void {
  if (!PROVIDERS.has(value.provider) || !SESSION_ID.test(value.sessionId))
    throw new Error("Invalid local session identity");
  boundedText(value.cwd, 4096, "working directory", true);
  boundedText(value.model, 200, "model");
  boundedText(value.title, 500, "title");
  boundedText(value.snippet, 1000, "snippet");
  timestamp(value.updatedAtMs);
  if (!MATCH_KINDS.has(value.matchKind)) throw new Error("Invalid local session match kind");
}

function excerptRequest(value: LocalSessionExcerptRequest): void {
  scope(value);
  if (!PROVIDERS.has(value.provider) || !SESSION_ID.test(value.sessionId))
    throw new Error("Invalid local session identity");
  boundedText(value.cwd, 4096, "working directory", true);
}

export function encodeLocalSessionSearchRequest(value: LocalSessionSearchRequest): Uint8Array {
  request(value);
  return toBinary(
    LocalSessionSearchRequestSchema,
    create(LocalSessionSearchRequestSchema, { ...value, messageType: SEARCH_REQUEST_TYPE }),
  );
}

export function decodeLocalSessionSearchRequest(bytes: Uint8Array): LocalSessionSearchRequest {
  const value = fromBinary(LocalSessionSearchRequestSchema, bytes);
  if (value.messageType !== SEARCH_REQUEST_TYPE)
    throw new Error("Invalid local session search request");
  const result = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    query: value.query,
  };
  request(result);
  return result;
}

export function encodeLocalSessionSearchResult(value: LocalSessionSearchResult): Uint8Array {
  request(value);
  if (value.sessions.length > 100) throw new Error("Too many local session results");
  value.sessions.forEach(entry);
  return toBinary(
    LocalSessionSearchResultSchema,
    create(LocalSessionSearchResultSchema, {
      ...value,
      messageType: SEARCH_RESULT_TYPE,
      sessions: value.sessions.map((session) =>
        create(LocalSessionEntrySchema, { ...session, updatedAtMs: BigInt(session.updatedAtMs) }),
      ),
    }),
  );
}

export function decodeLocalSessionSearchResult(bytes: Uint8Array): LocalSessionSearchResult {
  const value = fromBinary(LocalSessionSearchResultSchema, bytes);
  if (value.messageType !== SEARCH_RESULT_TYPE)
    throw new Error("Invalid local session search result");
  const result: LocalSessionSearchResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    query: value.query,
    sessions: value.sessions.map((session) => ({
      provider: session.provider as HandoffRuntimeProvider,
      sessionId: session.sessionId,
      cwd: session.cwd,
      model: session.model,
      title: session.title,
      updatedAtMs: Number(session.updatedAtMs),
      matchKind: session.matchKind as LocalSessionMatchKind,
      snippet: session.snippet,
    })),
    scanComplete: value.scanComplete,
    contentSearchComplete: value.contentSearchComplete,
  };
  request(result);
  if (result.sessions.length > 100) throw new Error("Too many local session results");
  result.sessions.forEach(entry);
  return result;
}

export function encodeLocalSessionExcerptRequest(value: LocalSessionExcerptRequest): Uint8Array {
  excerptRequest(value);
  return toBinary(
    LocalSessionExcerptRequestSchema,
    create(LocalSessionExcerptRequestSchema, { ...value, messageType: EXCERPT_REQUEST_TYPE }),
  );
}

export function decodeLocalSessionExcerptRequest(bytes: Uint8Array): LocalSessionExcerptRequest {
  const value = fromBinary(LocalSessionExcerptRequestSchema, bytes);
  if (value.messageType !== EXCERPT_REQUEST_TYPE)
    throw new Error("Invalid local session excerpt request");
  const result = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    provider: value.provider as HandoffRuntimeProvider,
    sessionId: value.sessionId,
    cwd: value.cwd,
  };
  excerptRequest(result);
  return result;
}

function validateExcerptResult(value: LocalSessionExcerptResult): void {
  excerptRequest(value);
  if (!STATUSES.has(value.status)) throw new Error("Invalid local session excerpt status");
  boundedText(value.model, 200, "model");
  boundedText(value.initialRequest, 8192, "initial request");
  timestamp(value.updatedAtMs);
  if (value.recentTurns.length > 12) throw new Error("Too many local session turns");
  let bytes = encoder.encode(value.initialRequest).byteLength;
  for (const turn of value.recentTurns) {
    if (!ROLES.has(turn.role)) throw new Error("Invalid local session turn role");
    boundedText(turn.text, 8192, "turn text", true);
    timestamp(turn.timestampMs);
    bytes += encoder.encode(turn.text).byteLength;
  }
  if (bytes > 24 * 1024) throw new Error("Local session excerpt is too large");
}

export function encodeLocalSessionExcerptResult(value: LocalSessionExcerptResult): Uint8Array {
  validateExcerptResult(value);
  return toBinary(
    LocalSessionExcerptResultSchema,
    create(LocalSessionExcerptResultSchema, {
      ...value,
      updatedAtMs: BigInt(value.updatedAtMs),
      messageType: EXCERPT_RESULT_TYPE,
      recentTurns: value.recentTurns.map((turn) =>
        create(LocalSessionTurnSchema, { ...turn, timestampMs: BigInt(turn.timestampMs) }),
      ),
    }),
  );
}

export function decodeLocalSessionExcerptResult(bytes: Uint8Array): LocalSessionExcerptResult {
  const value = fromBinary(LocalSessionExcerptResultSchema, bytes);
  if (value.messageType !== EXCERPT_RESULT_TYPE)
    throw new Error("Invalid local session excerpt result");
  const result: LocalSessionExcerptResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    provider: value.provider as HandoffRuntimeProvider,
    sessionId: value.sessionId,
    cwd: value.cwd,
    status: value.status as LocalSessionExcerptStatus,
    model: value.model,
    updatedAtMs: Number(value.updatedAtMs),
    initialRequest: value.initialRequest,
    recentTurns: value.recentTurns.map((turn) => ({
      role: turn.role as LocalSessionTurn["role"],
      text: turn.text,
      timestampMs: Number(turn.timestampMs),
    })),
  };
  validateExcerptResult(result);
  return result;
}
