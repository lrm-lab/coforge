import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentContextViewAvailabilitySchema,
  AgentContextViewRequestSchema,
  AgentContextViewResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_context_view_pb";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_CONTEXT_VIEW_CAPABILITY = "agent-context-view:v0" as const;
export const AGENT_CONTEXT_VIEW_METHOD = RPC_METHODS.daemonAgentContextView;
export const AGENT_CONTEXT_VIEW_RESULT_METHOD = RPC_METHODS.daemonAgentContextViewResult;
export const AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD = RPC_METHODS.agentContextViewAvailability;

const REQUEST_TYPE = "coforge.rpc.v1.AgentContextViewRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentContextViewResult";
const AVAILABILITY_TYPE = "coforge.rpc.v1.AgentContextViewAvailability";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_ID = /^ctxv_[A-Za-z0-9_-]{16,64}$/;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const STATUSES = new Set(["ok", "unavailable", "failed"]);
export const AGENT_CONTEXT_VIEW_FAILURE_REASONS = [
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
] as const;
export type AgentContextViewFailureReason = (typeof AGENT_CONTEXT_VIEW_FAILURE_REASONS)[number];
const REASONS = new Set<string>(AGENT_CONTEXT_VIEW_FAILURE_REASONS);
const ENCODINGS = new Set(["identity", "gzip"]);
const VERIFICATIONS = new Set(["verified", "count_matched"]);
const TOO_LARGE_CAUSES = new Set(["session_file", "request", "restore_limit"]);

export type AgentContextViewRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  messageId: string;
  sessionId: string;
  maxBytes: number;
};
export type AgentContextViewStatus = "ok" | "unavailable" | "failed";
export type AgentContextViewResult = AgentContextViewRequest & {
  status: AgentContextViewStatus;
  reason?: AgentContextViewFailureReason;
  provider?: string;
  createdAtMs: number;
  content: Uint8Array;
  encoding: "identity" | "gzip";
  failureDetail?: string;
  responseFound?: boolean;
  digestMatch?: boolean;
  triggerFound?: boolean;
  unrestoredMessageCount?: number;
  redactedMediaCount?: number;
  redactedDiagnosticCount?: number;
  viewBytes?: number;
  sourceBytes?: number;
  verification?: "verified" | "count_matched";
  tooLargeCause?: "session_file" | "request" | "restore_limit";
};
export type AgentContextViewAvailability = {
  protocolMajor: number;
  workspaceId: string;
  computerId: string;
  agentId: string;
  runtime: string;
  retainedSince?: string;
  retentionDays: number;
  supported: boolean;
  unsupportedReason?: "unsupported_runtime" | "no_session";
  trigger?: "startup" | "message" | "server_features" | "periodic" | "retention";
};

function text(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value) || value.includes("\0"))
    throw new Error(`Invalid context view ${label}`);
}
function scope(value: AgentContextViewRequest): void {
  if (value.protocolMajor !== 1) throw new Error("Invalid context view protocol");
  text(value.requestId, REQUEST_ID, "request id");
  text(value.workspaceId, ID, "workspace id");
  text(value.computerId, ID, "computer id");
  text(value.agentId, ID, "agent id");
  text(value.messageId, MESSAGE_ID, "message id");
  text(value.sessionId, SESSION_ID, "session id");
  if (
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > 32 * 1024 * 1024
  )
    throw new Error("Invalid context view max bytes");
}
function result(value: AgentContextViewResult): void {
  scope(value);
  if (!STATUSES.has(value.status)) throw new Error("Invalid context view status");
  if (value.reason !== undefined && !REASONS.has(value.reason))
    throw new Error("Invalid context view reason");
  if (value.status === "failed" && value.reason === undefined)
    throw new Error("Missing context view failure reason");
  if (value.status !== "failed" && value.failureDetail !== undefined)
    throw new Error("Unexpected context view failure detail");
  if (
    value.failureDetail !== undefined &&
    new TextEncoder().encode(value.failureDetail).byteLength > 1024
  )
    throw new Error("Context view failure detail is too large");
  if (value.status === "ok" && value.content.byteLength === 0)
    throw new Error("Empty context view result");
  if (value.content.byteLength > 32 * 1024 * 1024)
    throw new Error("Context view result is too large");
  if (!Number.isSafeInteger(value.createdAtMs) || value.createdAtMs < 0)
    throw new Error("Invalid context view timestamp");
  for (const [label, count] of [
    ["unrestored message", value.unrestoredMessageCount],
    ["redacted media", value.redactedMediaCount],
    ["redacted diagnostic", value.redactedDiagnosticCount],
    ["view bytes", value.viewBytes],
  ] as const) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
      throw new Error(`Invalid context view ${label} count`);
  }
  if (value.viewBytes !== undefined && value.viewBytes > 32 * 1024 * 1024)
    throw new Error("Context view view bytes are too large");
  if (
    value.sourceBytes !== undefined &&
    (!Number.isSafeInteger(value.sourceBytes) ||
      value.sourceBytes < 0 ||
      value.sourceBytes > 512 * 1024 * 1024)
  )
    throw new Error("Invalid context view source bytes");
  if (value.verification !== undefined && !VERIFICATIONS.has(value.verification))
    throw new Error("Invalid context view verification");
  if (value.tooLargeCause !== undefined && !TOO_LARGE_CAUSES.has(value.tooLargeCause))
    throw new Error("Invalid context view too-large cause");
  if (value.tooLargeCause !== undefined && value.reason !== "too_large")
    throw new Error("Unexpected context view too-large cause");
  if (!ENCODINGS.has(value.encoding)) throw new Error("Invalid context view encoding");
}

function parseFailureReason(value: string): AgentContextViewFailureReason | undefined {
  return REASONS.has(value) ? (value as AgentContextViewFailureReason) : undefined;
}

export function encodeAgentContextViewRequest(value: AgentContextViewRequest): Uint8Array {
  scope(value);
  return toBinary(
    AgentContextViewRequestSchema,
    create(AgentContextViewRequestSchema, {
      ...value,
      messageType: REQUEST_TYPE,
    }),
  );
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
    maxBytes: value.maxBytes,
  };
  scope(resultValue);
  return resultValue;
}
export function encodeAgentContextViewResult(value: AgentContextViewResult): Uint8Array {
  result(value);
  return toBinary(
    AgentContextViewResultSchema,
    create(AgentContextViewResultSchema, {
      ...value,
      messageType: RESULT_TYPE,
      maxBytes: value.maxBytes,
      createdAtMs: BigInt(value.createdAtMs),
      sourceBytes: value.sourceBytes === undefined ? undefined : BigInt(value.sourceBytes),
    }),
  );
}
export function decodeAgentContextViewResult(bytes: Uint8Array): AgentContextViewResult {
  const value = fromBinary(AgentContextViewResultSchema, bytes);
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid context view result");
  const reason = value.reason ? parseFailureReason(value.reason) : undefined;
  if (value.reason && reason === undefined) throw new Error("Invalid context view reason");
  const resultValue: AgentContextViewResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    messageId: value.messageId,
    sessionId: value.sessionId,
    maxBytes: value.maxBytes,
    status: value.status as AgentContextViewStatus,
    reason,
    provider: value.provider || undefined,
    createdAtMs: Number(value.createdAtMs),
    content: value.content,
    encoding: value.encoding as AgentContextViewResult["encoding"],
    failureDetail: value.failureDetail || undefined,
    responseFound: value.responseFound,
    digestMatch: value.digestMatch,
    triggerFound: value.triggerFound,
    unrestoredMessageCount: value.unrestoredMessageCount,
    redactedMediaCount: value.redactedMediaCount,
    redactedDiagnosticCount: value.redactedDiagnosticCount,
    viewBytes: value.viewBytes,
    sourceBytes: value.sourceBytes === undefined ? undefined : Number(value.sourceBytes),
    verification: VERIFICATIONS.has(value.verification)
      ? (value.verification as AgentContextViewResult["verification"])
      : undefined,
    tooLargeCause: TOO_LARGE_CAUSES.has(value.tooLargeCause)
      ? (value.tooLargeCause as AgentContextViewResult["tooLargeCause"])
      : undefined,
  };
  result(resultValue);
  return resultValue;
}

function validateAvailability(value: AgentContextViewAvailability): void {
  if (
    value.protocolMajor !== 1 ||
    !ID.test(value.workspaceId) ||
    !ID.test(value.computerId) ||
    !ID.test(value.agentId)
  )
    throw new Error("Invalid context view availability scope");
  if (
    !value.runtime ||
    !Number.isSafeInteger(value.retentionDays) ||
    value.retentionDays < 1 ||
    value.retentionDays > 365
  )
    throw new Error("Invalid context view availability");
  if (!value.supported && value.unsupportedReason === undefined)
    throw new Error("Missing context view unsupported reason");
  if (
    value.trigger !== undefined &&
    !new Set(["startup", "message", "server_features", "periodic", "retention"]).has(
      value.trigger,
    )
  )
    throw new Error("Invalid context view availability trigger");
}

export function encodeAgentContextViewAvailability(
  value: AgentContextViewAvailability,
): Uint8Array {
  validateAvailability(value);
  return toBinary(
    AgentContextViewAvailabilitySchema,
    create(AgentContextViewAvailabilitySchema, {
      ...value,
      messageType: AVAILABILITY_TYPE,
    }),
  );
}

export function decodeAgentContextViewAvailability(
  bytes: Uint8Array,
): AgentContextViewAvailability {
  const value = fromBinary(AgentContextViewAvailabilitySchema, bytes);
  if (value.messageType !== AVAILABILITY_TYPE) throw new Error("Invalid context view availability");
  const resultValue: AgentContextViewAvailability = {
    protocolMajor: value.protocolMajor,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    runtime: value.runtime,
    retainedSince: value.retainedSince || undefined,
    retentionDays: value.retentionDays,
    supported: value.supported,
    unsupportedReason: value.unsupportedReason
      ? (value.unsupportedReason as AgentContextViewAvailability["unsupportedReason"])
      : undefined,
    trigger: value.trigger ? (value.trigger as AgentContextViewAvailability["trigger"]) : undefined,
  };
  validateAvailability(resultValue);
  return resultValue;
}
