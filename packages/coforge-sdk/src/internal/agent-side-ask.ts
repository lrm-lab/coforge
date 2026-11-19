import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentSideAskAskerSchema,
  AgentSideAskRequestSchema,
  AgentSideAskResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/agent_side_ask_pb";
import { RPC_METHODS } from "./rpc-methods";

export const AGENT_SIDE_ASK_CAPABILITY = "agent-side-ask:v1" as const;
export const AGENT_SIDE_ASK_RESULT_METHOD = RPC_METHODS.daemonAgentSideAskResult;

export const AGENT_SIDE_ASK_QUESTION_MAX_CHARS = 2_000;
export const AGENT_SIDE_ASK_ANSWER_MAX_CHARS = 4_000;
export const AGENT_SIDE_ASK_ASKER_NAME_MAX_CHARS = 120;
export const AGENT_SIDE_ASK_MIN_TIMEOUT_MS = 1_000;
export const AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS = 45_000;
export const AGENT_SIDE_ASK_MAX_TIMEOUT_MS = 60_000;
export const AGENT_SIDE_ASK_FORK_MAX_CONTEXT_TOKENS = 600_000;

export const AGENT_SIDE_ASK_KINDS = ["status", "question"] as const;
export type AgentSideAskKind = (typeof AGENT_SIDE_ASK_KINDS)[number];

export const AGENT_SIDE_ASK_STATUSES = ["ok", "failed"] as const;
export type AgentSideAskStatus = (typeof AGENT_SIDE_ASK_STATUSES)[number];

export const AGENT_SIDE_ASK_ASKER_ROLES = ["owner", "admin", "member"] as const;
export type AgentSideAskAskerRole = (typeof AGENT_SIDE_ASK_ASKER_ROLES)[number];

export const AGENT_SIDE_ASK_FAILURE_REASONS = [
  "offline",
  "old_daemon",
  "no_computer",
  "agent_not_running",
  "unsupported_runtime",
  "busy",
  "usage_limited",
  "context_too_large",
  "timeout",
  "cancelled",
  "failed",
] as const;
export type AgentSideAskFailureReason = (typeof AGENT_SIDE_ASK_FAILURE_REASONS)[number];

const REQUEST_TYPE = "coforge.rpc.v1.AgentSideAskRequest";
const RESULT_TYPE = "coforge.rpc.v1.AgentSideAskResult";
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REQUEST_ID = /^sask_[A-Za-z0-9_-]{16,64}$/;
const RUNTIME_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS = new Set<string>(AGENT_SIDE_ASK_KINDS);
const STATUSES = new Set<string>(AGENT_SIDE_ASK_STATUSES);
const ROLES = new Set<string>(AGENT_SIDE_ASK_ASKER_ROLES);
const REASONS = new Set<string>(AGENT_SIDE_ASK_FAILURE_REASONS);

export type AgentSideAskAsker = {
  userId: string;
  displayName: string;
  role: AgentSideAskAskerRole;
  isAgentOwner: boolean;
};

export type AgentSideAskRequest = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  kind: AgentSideAskKind;
  question: string;
  timeoutMs: number;
  asker: AgentSideAskAsker;
};

export type AgentSideAskResult = {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  askerUserId: string;
  kind: AgentSideAskKind;
  status: AgentSideAskStatus;
  reason?: AgentSideAskFailureReason;
  answer: string;
  runtime?: string;
  durationMs: number;
};

function assertPattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value) || value.includes("\0")) throw new Error(`Invalid side ask ${label}`);
}

function validateAsker(asker: AgentSideAskAsker): void {
  assertPattern(asker.userId, ID, "asker user id");
  if (
    asker.displayName.includes("\0") ||
    asker.displayName.trim().length === 0 ||
    asker.displayName.length > AGENT_SIDE_ASK_ASKER_NAME_MAX_CHARS
  )
    throw new Error("Invalid side ask asker display name");
  if (!ROLES.has(asker.role)) throw new Error("Invalid side ask asker role");
  if (typeof asker.isAgentOwner !== "boolean") throw new Error("Invalid side ask asker ownership");
}

function validateRequest(value: AgentSideAskRequest): void {
  if (value.protocolMajor !== 1) throw new Error("Invalid side ask protocol");
  assertPattern(value.requestId, REQUEST_ID, "request id");
  assertPattern(value.workspaceId, ID, "workspace id");
  assertPattern(value.computerId, ID, "computer id");
  assertPattern(value.agentId, ID, "agent id");
  if (!KINDS.has(value.kind)) throw new Error("Invalid side ask kind");
  if (value.question.includes("\0") || value.question.length > AGENT_SIDE_ASK_QUESTION_MAX_CHARS)
    throw new Error("Invalid side ask question");
  if (value.kind === "question" && value.question.trim().length === 0)
    throw new Error("Empty side ask question");
  if (value.kind === "status" && value.question.length > 0)
    throw new Error("Unexpected side ask question for status request");
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < AGENT_SIDE_ASK_MIN_TIMEOUT_MS ||
    value.timeoutMs > AGENT_SIDE_ASK_MAX_TIMEOUT_MS
  )
    throw new Error("Invalid side ask timeout");
  validateAsker(value.asker);
}

function validateResult(value: AgentSideAskResult): void {
  if (value.protocolMajor !== 1) throw new Error("Invalid side ask protocol");
  assertPattern(value.requestId, REQUEST_ID, "request id");
  assertPattern(value.workspaceId, ID, "workspace id");
  assertPattern(value.computerId, ID, "computer id");
  assertPattern(value.agentId, ID, "agent id");
  assertPattern(value.askerUserId, ID, "asker user id");
  if (!KINDS.has(value.kind)) throw new Error("Invalid side ask kind");
  if (!STATUSES.has(value.status)) throw new Error("Invalid side ask status");
  if (value.reason !== undefined && !REASONS.has(value.reason))
    throw new Error("Invalid side ask failure reason");
  if (value.runtime !== undefined) assertPattern(value.runtime, RUNTIME_ID, "runtime");
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 600_000)
    throw new Error("Invalid side ask duration");
  if (value.answer.includes("\0") || value.answer.length > AGENT_SIDE_ASK_ANSWER_MAX_CHARS)
    throw new Error("Invalid side ask answer");
  if (value.status === "ok") {
    if (value.reason !== undefined) throw new Error("Unexpected side ask failure reason");
    if (value.answer.trim().length === 0) throw new Error("Empty side ask answer");
  } else {
    if (value.reason === undefined) throw new Error("Missing side ask failure reason");
    if (value.answer.length > 0) throw new Error("Unexpected side ask answer on failure");
  }
}

export function encodeAgentSideAskRequest(value: AgentSideAskRequest): Uint8Array {
  validateRequest(value);
  return toBinary(
    AgentSideAskRequestSchema,
    create(AgentSideAskRequestSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      agentId: value.agentId,
      kind: value.kind,
      question: value.question,
      timeoutMs: value.timeoutMs,
      asker: create(AgentSideAskAskerSchema, value.asker),
      messageType: REQUEST_TYPE,
    }),
  );
}

const latin1Decoder = new TextDecoder("latin1");

export function isAgentSideAskRequestId(value: string): boolean {
  return REQUEST_ID.test(value) && !value.includes("\0");
}

export function isAgentSideAskRequest(bytes: Uint8Array): boolean {
  try {
    if (fromBinary(AgentSideAskRequestSchema, bytes).messageType === REQUEST_TYPE) return true;
  } catch {}
  return latin1Decoder.decode(bytes).includes(REQUEST_TYPE);
}

export function decodeAgentSideAskRequest(bytes: Uint8Array): AgentSideAskRequest {
  const value = fromBinary(AgentSideAskRequestSchema, bytes);
  if (value.messageType !== REQUEST_TYPE || !value.asker)
    throw new Error("Invalid side ask request");
  const decoded: AgentSideAskRequest = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    kind: value.kind as AgentSideAskKind,
    question: value.question,
    timeoutMs: value.timeoutMs,
    asker: {
      userId: value.asker.userId,
      displayName: value.asker.displayName,
      role: value.asker.role as AgentSideAskAskerRole,
      isAgentOwner: value.asker.isAgentOwner,
    },
  };
  validateRequest(decoded);
  return decoded;
}

export function encodeAgentSideAskResult(value: AgentSideAskResult): Uint8Array {
  validateResult(value);
  return toBinary(
    AgentSideAskResultSchema,
    create(AgentSideAskResultSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      agentId: value.agentId,
      askerUserId: value.askerUserId,
      kind: value.kind,
      status: value.status,
      reason: value.reason ?? "",
      answer: value.answer,
      runtime: value.runtime ?? "",
      durationMs: value.durationMs,
      messageType: RESULT_TYPE,
    }),
  );
}

export function decodeAgentSideAskResult(bytes: Uint8Array): AgentSideAskResult {
  const value = fromBinary(AgentSideAskResultSchema, bytes);
  if (value.messageType !== RESULT_TYPE) throw new Error("Invalid side ask result");
  const reason = value.reason
    ? REASONS.has(value.reason)
      ? (value.reason as AgentSideAskFailureReason)
      : (() => {
          throw new Error("Invalid side ask failure reason");
        })()
    : undefined;
  const decoded: AgentSideAskResult = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    askerUserId: value.askerUserId,
    kind: value.kind as AgentSideAskKind,
    status: value.status as AgentSideAskStatus,
    ...(reason ? { reason } : {}),
    answer: value.answer,
    ...(value.runtime ? { runtime: value.runtime } : {}),
    durationMs: value.durationMs,
  };
  validateResult(decoded);
  return decoded;
}
