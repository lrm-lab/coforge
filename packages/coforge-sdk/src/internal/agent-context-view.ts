import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentContextViewRequestSchema,
  AgentContextViewResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_context_view_pb";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_CONTEXT_VIEW_CAPABILITY = "agent-context-view:v0" as const;
export const AGENT_CONTEXT_VIEW_METHOD = RPC_METHODS.daemonAgentContextView;
export const AGENT_CONTEXT_VIEW_RESULT_METHOD = RPC_METHODS.daemonAgentContextViewResult;

const REQUEST_TYPE = "coforge.rpc.v1.AgentContextViewRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentContextViewResult";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STATUSES = new Set(["ok", "unavailable", "failed"]);
const REASONS = new Set([
  "offline",
  "old_daemon",
  "agent_moved",
  "not_found",
  "expired",
  "unsupported_runtime",
  "too_large",
  "read_failed",
  "no_computer",
  "context_mismatch",
  "media_removed",
  "newer_session_format",
  "not_recorded",
]);
const ENCODINGS = new Set(["identity", "gzip"]);

export type AgentContextViewRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  messageId: string;
  sessionId: string;
};
export type AgentContextViewStatus = "ok" | "unavailable" | "failed";
export type AgentContextViewResult = AgentContextViewRequest & {
  status: AgentContextViewStatus;
  reason?: string;
  provider?: string;
  createdAtMs: number;
  content: Uint8Array;
  encoding: "identity" | "gzip";
};

function text(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value) || value.includes("\0")) throw new Error(`Invalid context view ${label}`);
}
function scope(value: AgentContextViewRequest): void {
  if (value.protocolMajor !== 1) throw new Error("Invalid context view protocol");
  text(value.requestId, ID, "request id");
  text(value.workspaceId, ID, "workspace id");
  text(value.computerId, ID, "computer id");
  text(value.agentId, ID, "agent id");
  text(value.messageId, MESSAGE_ID, "message id");
  text(value.sessionId, SESSION_ID, "session id");
}
function result(value: AgentContextViewResult): void {
  scope(value);
  if (!STATUSES.has(value.status)) throw new Error("Invalid context view status");
  if (value.reason !== undefined && !REASONS.has(value.reason)) throw new Error("Invalid context view reason");
  if (value.status === "ok" && value.content.byteLength === 0) throw new Error("Empty context view result");
  if (value.content.byteLength > 32 * 1024 * 1024) throw new Error("Context view result is too large");
  if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0)
    throw new Error("Invalid context view timestamp");
  if (!ENCODINGS.has(value.encoding)) throw new Error("Invalid context view encoding");
}

export function encodeAgentContextViewRequest(value: AgentContextViewRequest): Uint8Array {
  scope(value);
  return toBinary(AgentContextViewRequestSchema, create(AgentContextViewRequestSchema, {
    ...value,
    messageType: REQUEST_TYPE,
  }));
}
export function decodeAgentContextViewRequest(bytes: Uint8Array): AgentContextViewRequest {
  const value = fromBinary(AgentContextViewRequestSchema, bytes);
  if (value.messageType !== REQUEST_TYPE) throw new Error("Invalid context view request");
  const resultValue = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    messageId: value.messageId,
    sessionId: value.sessionId,
  };
  scope(resultValue);
  return resultValue;
}
export function encodeAgentContextViewResult(value: AgentContextViewResult): Uint8Array {
  result(value);
  return toBinary(AgentContextViewResultSchema, create(AgentContextViewResultSchema, {
    ...value,
    messageType: RESULT_TYPE,
    createdAtMs: BigInt(value.createdAtMs),
  }));
}
export function decodeAgentContextViewResult(bytes: Uint8Array): AgentContextViewResult {
  const value = fromBinary(AgentContextViewResultSchema, bytes);
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid context view result");
  const resultValue: AgentContextViewResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    messageId: value.messageId,
    sessionId: value.sessionId,
    status: value.status as AgentContextViewStatus,
    reason: value.reason || undefined,
    provider: value.provider || undefined,
    createdAtMs: Number(value.createdAtMs),
    content: value.content,
    encoding: value.encoding as AgentContextViewResult["encoding"],
  };
  result(resultValue);
  return resultValue;
}
