import {
  decodedModelCatalog,
  decodedRuntimeMetadata,
  modelCatalog,
  runtimeMetadata,
} from "./codec-runtime-inventory";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { RUNTIME_PROVIDER, AGENT_SESSION_INVALIDATE_REASONS, type RuntimeProvider } from "./index";
import { safeUint64 } from "./agent-observation-codec";
export { decodeAgentActivity, encodeAgentActivity } from "./agent-activity-codec";
export {
  AGENT_START_PROMPT_MAX_LENGTH,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
  encodeAgentStopIntent,
  decodeAgentStopIntent,
} from "./agent-intent-codec";
import {
  DaemonRuntimeCodeAgentsUpdateRequestSchema,
  DaemonRuntimeUsageScanRequestSchema,
  DaemonRuntimeUsageScanResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  AgentSessionReportSchema,
  AgentSessionInvalidateSchema,
  AgentActivityProbeSchema,
  AgentInboxPurgeSchema,
  AgentStatusSchema,
  AgentMessageDeliveryAckSchema,
  AgentMessageDeliveryRejectionSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import type {
  AgentSessionReport,
  AgentSessionInvalidate,
  AgentActivityProbe,
  AgentInboxPurge,
  AgentStatus,
  AgentMessageDeliveryAck,
  AgentMessageDeliveryRejection,
  AgentMessageRequest,
} from "./index";
import {
  AGENT_ACTIVITY_PROBE_MESSAGE_TYPE,
  AGENT_INBOX_PURGE_MESSAGE_TYPE,
  AGENT_INBOX_PURGE_REASONS,
  AGENT_MESSAGE_DELIVERY_REJECTION_REASONS,
  USAGE_SCAN_MESSAGE_TYPE,
  USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
} from "./index";
import { AGENT_MESSAGE_ACK_METHOD, AGENT_MESSAGE_REJECT_METHOD } from "./index";
import { isSeenExactSeqs } from "./freshness-decision";
import { mentionDeliveryEnvelopeMessage, readMentionDeliveryEnvelope } from "./mention-delivery";
import type { DaemonRuntimeCodeAgentsUpdateRequest } from "./index";

export function assertUint(value: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`invalid ${field}`);
}

export function assertPositiveControlCounter(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1)
    throw new Error(`invalid ${field}`);
}

const MAX_AGENT_SESSION_REPORT_BYTES = 32_768;
const MAX_AGENT_SESSION_INVALIDATE_BYTES = 32_768;

export {
  encodeComputerRestartIntent,
  decodeComputerRestartIntent,
  encodeComputerUpgradeIntent,
  decodeComputerUpgradeIntent,
  encodeComputerUpgradeResult,
  decodeComputerUpgradeResult,
  sanitizeUpgradeErrorText,
} from "./computer-lifecycle-codec";

export function encodeDaemonRuntimeCodeAgentsUpdateRequest(
  value: DaemonRuntimeCodeAgentsUpdateRequest,
): Uint8Array {
  return toBinary(
    DaemonRuntimeCodeAgentsUpdateRequestSchema,
    create(DaemonRuntimeCodeAgentsUpdateRequestSchema, {
      ...value,
      runtimes: value.runtimes.map(runtimeMetadata),
      catalogs: value.catalogs.map(modelCatalog),
    }),
  );
}

export function decodeDaemonRuntimeCodeAgentsUpdateRequest(
  bytes: Uint8Array,
): DaemonRuntimeCodeAgentsUpdateRequest {
  const value = fromBinary(DaemonRuntimeCodeAgentsUpdateRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    runtimes: value.runtimes.map(decodedRuntimeMetadata),
    catalogs: value.catalogs.map(decodedModelCatalog),
  };
}
export const encodeDaemonRuntimeUsageScanRequest = (
  v: import("./index").DaemonRuntimeUsageScanRequest,
) =>
  toBinary(
    DaemonRuntimeUsageScanRequestSchema,
    create(DaemonRuntimeUsageScanRequestSchema, { ...v, messageType: USAGE_SCAN_MESSAGE_TYPE }),
  );
export function decodeDaemonRuntimeUsageScanRequest(bytes: Uint8Array) {
  const v = fromBinary(DaemonRuntimeUsageScanRequestSchema, bytes);
  if (v.messageType !== USAGE_SCAN_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    provider: v.provider as import("./index").RuntimeProvider,
    messageType: v.messageType,
  };
}
export const encodeDaemonRuntimeUsageScanResponse = (
  v: import("./index").DaemonRuntimeUsageScanResponse,
) =>
  toBinary(
    DaemonRuntimeUsageScanResponseSchema,
    create(DaemonRuntimeUsageScanResponseSchema, {
      ...v,
      messageType: USAGE_SCAN_RESPONSE_MESSAGE_TYPE,
    }),
  );
export function decodeDaemonRuntimeUsageScanResponse(bytes: Uint8Array) {
  const v = fromBinary(DaemonRuntimeUsageScanResponseSchema, bytes);
  if (v.messageType !== USAGE_SCAN_RESPONSE_MESSAGE_TYPE)
    throw new Error("invalid daemon runtime message type");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    provider: v.provider as import("./index").RuntimeProvider,
    accepted: v.accepted,
    status: v.status,
    message: v.message || undefined,
    snapshotJson: v.snapshotJson.length ? v.snapshotJson : undefined,
    messageType: v.messageType,
  };
}
export {
  encodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeDaemonRuntimeProviderModelRefreshResponse,
} from "./codec-model-refresh";
export function encodeAgentSessionReport(value: AgentSessionReport): Uint8Array {
  validateAgentSessionReport(value);
  const bytes = toBinary(AgentSessionReportSchema, create(AgentSessionReportSchema, value));
  if (bytes.length > MAX_AGENT_SESSION_REPORT_BYTES)
    throw new Error("Agent Session report payload too large");
  return bytes;
}

export function decodeAgentSessionReport(bytes: Uint8Array): AgentSessionReport {
  if (bytes.length > MAX_AGENT_SESSION_REPORT_BYTES)
    throw new Error("Agent Session report payload too large");
  const { $typeName: _, ...value } = fromBinary(AgentSessionReportSchema, bytes);
  validateAgentSessionReport(value);
  return value;
}

function validateAgentSessionReport(value: {
  protocolMajor: number;
  provider: string;
  [key: string]: unknown;
}): asserts value is AgentSessionReport {
  if (
    value.protocolMajor !== 1 ||
    !Object.values(RUNTIME_PROVIDER).includes(value.provider as RuntimeProvider)
  )
    throw new Error("invalid session report protocol/provider");
  if (value.controlEpoch !== undefined) {
    assertPositiveControlCounter(value.controlEpoch as number, "Agent control epoch");
  }
  if (value.sequence !== undefined) {
    assertPositiveControlCounter(value.sequence as number, "Agent Session sequence");
    if (value.controlEpoch === undefined || value.sessionState === undefined)
      throw new Error("Session snapshot requires control epoch and state");
  }
  if (value.sessionState !== undefined && value.sequence === undefined)
    throw new Error("Session state requires a sequence");
  if (
    value.sessionState !== undefined &&
    !["empty", "resumable", "unknown"].includes(value.sessionState as string)
  )
    throw new Error("invalid Session state");
  for (const field of [
    "requestId",
    "workspaceId",
    "computerId",
    "agentId",
    "startRequestId",
    "daemonInstanceId",
    "launchId",
    ...(value.previousLaunchId === undefined ? [] : ["previousLaunchId"]),
    ...(value.replacedSessionId === undefined ? [] : ["replacedSessionId"]),
  ])
    if (
      typeof value[field] !== "string" ||
      !(value[field] as string).trim() ||
      (value[field] as string).length > 512
    )
      throw new Error(`invalid session report ${field}`);
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.length > 512 ||
    (value.sessionId.length === 0 && value.sessionState !== "empty") ||
    (value.sessionId.length > 0 && !value.sessionId.trim())
  )
    throw new Error("invalid session report sessionId");
}

export function encodeAgentSessionInvalidate(value: AgentSessionInvalidate): Uint8Array {
  validateAgentSessionInvalidate(value);
  const bytes = toBinary(AgentSessionInvalidateSchema, create(AgentSessionInvalidateSchema, value));
  if (bytes.length > MAX_AGENT_SESSION_INVALIDATE_BYTES)
    throw new Error("Agent Session invalidate payload too large");
  return bytes;
}

export function decodeAgentSessionInvalidate(bytes: Uint8Array): AgentSessionInvalidate {
  if (bytes.length > MAX_AGENT_SESSION_INVALIDATE_BYTES)
    throw new Error("Agent Session invalidate payload too large");
  const { $typeName: _, ...value } = fromBinary(AgentSessionInvalidateSchema, bytes);
  validateAgentSessionInvalidate(value);
  return value;
}

function validateAgentSessionInvalidate(value: {
  protocolMajor: number;
  provider: string;
  reason: string;
  [key: string]: unknown;
}): asserts value is AgentSessionInvalidate {
  if (
    value.protocolMajor !== 1 ||
    !Object.values(RUNTIME_PROVIDER).includes(value.provider as RuntimeProvider)
  )
    throw new Error("invalid session invalidate protocol/provider");
  if (!Object.values(AGENT_SESSION_INVALIDATE_REASONS).includes(value.reason as never))
    throw new Error("invalid session invalidate reason");
  for (const field of [
    "requestId",
    "workspaceId",
    "computerId",
    "agentId",
    "daemonInstanceId",
    "launchId",
  ])
    if (
      typeof value[field] !== "string" ||
      !(value[field] as string).trim() ||
      (value[field] as string).length > 512
    )
      throw new Error(`invalid session invalidate ${field}`);
  if (
    typeof value.sessionId !== "string" ||
    !value.sessionId.trim() ||
    value.sessionId.length > 512
  )
    throw new Error("invalid session invalidate sessionId");
}

export function encodeAgentActivityProbe(value: AgentActivityProbe): Uint8Array {
  return toBinary(
    AgentActivityProbeSchema,
    create(AgentActivityProbeSchema, {
      ...value,
      messageType: AGENT_ACTIVITY_PROBE_MESSAGE_TYPE,
    }),
  );
}

export function decodeAgentActivityProbe(bytes: Uint8Array): AgentActivityProbe {
  const value = fromBinary(AgentActivityProbeSchema, bytes);
  if (
    value.messageType !== AGENT_ACTIVITY_PROBE_MESSAGE_TYPE ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    !value.agentId ||
    !value.probeId
  )
    throw new Error("invalid agent activity probe");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    probeId: value.probeId,
  };
}

export function encodeAgentInboxPurge(value: AgentInboxPurge): Uint8Array {
  return toBinary(
    AgentInboxPurgeSchema,
    create(AgentInboxPurgeSchema, {
      ...value,
      messageType: AGENT_INBOX_PURGE_MESSAGE_TYPE,
    }),
  );
}

export function decodeAgentInboxPurge(bytes: Uint8Array): AgentInboxPurge {
  const value = fromBinary(AgentInboxPurgeSchema, bytes);
  const reason = AGENT_INBOX_PURGE_REASONS.find((candidate) => candidate === value.reason);
  if (
    value.messageType !== AGENT_INBOX_PURGE_MESSAGE_TYPE ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    !value.agentId ||
    !value.conversationIds.length ||
    value.conversationIds.some((id) => !id.trim()) ||
    value.targets.length !== value.conversationIds.length ||
    value.targets.some((target) => !target.startsWith("#") || target.length < 2) ||
    !reason
  )
    throw new Error("invalid agent inbox purge");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    conversationIds: [...value.conversationIds],
    targets: [...value.targets],
    reason,
  };
}

export function encodeAgentMessageDeliveryAck(value: AgentMessageDeliveryAck): Uint8Array {
  assertUint(value.sequence, Number.MAX_SAFE_INTEGER, "Agent delivery ACK sequence");
  return toBinary(
    AgentMessageDeliveryAckSchema,
    create(AgentMessageDeliveryAckSchema, {
      ...value,
      sequence: BigInt(value.sequence),
      mentionDelivery: mentionDeliveryEnvelopeMessage(value.mentionDelivery),
    }),
  );
}
/** The delivery identity an ACK and a rejection both carry; every field is required. */
function hasDeliveryIdentity(value: {
  requestId: string;
  deliveryId: string;
  messageId: string;
  workspaceId: string;
  agentId: string;
  sequence: unknown;
}): boolean {
  return Boolean(
    value.requestId &&
    value.deliveryId &&
    value.messageId &&
    value.workspaceId &&
    value.agentId &&
    value.sequence,
  );
}
export function decodeAgentMessageDeliveryAck(bytes: Uint8Array): AgentMessageDeliveryAck {
  const v = fromBinary(AgentMessageDeliveryAckSchema, bytes);
  if (v.method !== AGENT_MESSAGE_ACK_METHOD || !hasDeliveryIdentity(v))
    throw new Error("invalid agent delivery ack");
  const { $typeName: _, mentionDelivery: envelope, ...fields } = v;
  const mentionDelivery = readMentionDeliveryEnvelope(envelope);
  return {
    ...fields,
    sequence: safeUint64(v.sequence, "Agent delivery ACK sequence"),
    method: AGENT_MESSAGE_ACK_METHOD,
    ...(mentionDelivery ? { mentionDelivery } : {}),
  };
}
function validateAgentMessageDeliveryRejection(
  value: Omit<AgentMessageDeliveryRejection, "method" | "reason"> & {
    method: string;
    reason: string;
  },
): AgentMessageDeliveryRejection {
  const reason = AGENT_MESSAGE_DELIVERY_REJECTION_REASONS.find(
    (candidate) => candidate === value.reason,
  );
  if (value.method !== AGENT_MESSAGE_REJECT_METHOD || !reason || !hasDeliveryIdentity(value))
    throw new Error("invalid agent delivery rejection");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    deliveryId: value.deliveryId,
    messageId: value.messageId,
    workspaceId: value.workspaceId,
    agentId: value.agentId,
    sequence: value.sequence,
    reason,
    method: AGENT_MESSAGE_REJECT_METHOD,
  };
}
export function encodeAgentMessageDeliveryRejection(
  value: AgentMessageDeliveryRejection,
): Uint8Array {
  assertUint(value.sequence, Number.MAX_SAFE_INTEGER, "Agent delivery rejection sequence");
  const rejection = validateAgentMessageDeliveryRejection(value);
  return toBinary(
    AgentMessageDeliveryRejectionSchema,
    create(AgentMessageDeliveryRejectionSchema, {
      ...rejection,
      sequence: BigInt(rejection.sequence),
    }),
  );
}
export function decodeAgentMessageDeliveryRejection(
  bytes: Uint8Array,
): AgentMessageDeliveryRejection {
  const v = fromBinary(AgentMessageDeliveryRejectionSchema, bytes);
  return validateAgentMessageDeliveryRejection({
    ...v,
    sequence: safeUint64(v.sequence, "Agent delivery rejection sequence"),
  });
}
const AGENT_MESSAGE_OPERATIONS = [
  "check",
  "read",
  "search",
  "send",
  "mute",
  "unmute",
  "thread-unfollow",
  "resolve",
  "react",
  "unreact",
];
/** Operations addressed by a message id or a query rather than a conversation target. */
const TARGETLESS_AGENT_MESSAGE_OPERATIONS = ["check", "search", "resolve", "react", "unreact"];
/**
 * Validates an Agent message request shape (operation allow-list including
 * `check`, target presence for targeted operations, messageId/emoji presence
 * for resolve/react/unreact) and returns it unchanged, or throws. Replaces
 * the validation `decodeAgentMessageRequest` used to enforce on the wire
 * form now that `AgentMessageRequest` is a plain TS type (no proto message,
 * no cloud-facing byte encoding — the Centrifugo RPC handler that needed
 * that form is gone).
 */
export function validateAgentMessageRequest(request: AgentMessageRequest): AgentMessageRequest {
  if (
    request.freshnessContextMode !== undefined &&
    request.freshnessContextMode !== "inline" &&
    request.freshnessContextMode !== "withheld"
  )
    throw new Error("invalid Agent message freshness context mode");
  if (request.seenUpToSeq !== undefined && request.operation !== "send")
    throw new Error("Agent message seen-up-to sequence is only valid for send");
  if (request.seenExactSeqs !== undefined && request.operation !== "send")
    throw new Error("Agent message exact seen sequences are only valid for send");
  if (request.seenExactSeqs !== undefined && !isSeenExactSeqs(request.seenExactSeqs))
    throw new Error("invalid Agent message exact seen sequences");
  if (
    !request.idempotencyKey ||
    !request.agentId ||
    !AGENT_MESSAGE_OPERATIONS.includes(request.operation) ||
    (!TARGETLESS_AGENT_MESSAGE_OPERATIONS.includes(request.operation) && !request.target) ||
    (["resolve", "react", "unreact"].includes(request.operation) && !request.messageId) ||
    (["react", "unreact"].includes(request.operation) && !request.emoji)
  )
    throw new Error("invalid cloud agent message request");
  return request;
}
export function encodeAgentStatus(value: AgentStatus): Uint8Array {
  validateAgentStatus(value);
  return toBinary(
    AgentStatusSchema,
    create(AgentStatusSchema, {
      ...value,
      clientSeq: BigInt(value.clientSeq),
      observedAtMs: BigInt(value.observedAtMs),
    }),
  );
}

export function decodeAgentStatus(bytes: Uint8Array): AgentStatus {
  const value = fromBinary(AgentStatusSchema, bytes);
  const status = {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    status: value.status,
    daemonInstanceId: value.daemonInstanceId,
    clientSeq: Number(value.clientSeq),
    observedAtMs: Number(value.observedAtMs),
  };
  validateAgentStatus(status);
  return status;
}

function validateAgentStatus(value: {
  protocolMajor: number;
  requestId: string;
  workspaceId: string;
  computerId: string;
  agentId: string;
  status: string;
  daemonInstanceId: string;
  clientSeq: number;
  observedAtMs: number;
}): asserts value is AgentStatus {
  if (
    value.protocolMajor !== 1 ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    !value.agentId ||
    !value.daemonInstanceId ||
    !Number.isSafeInteger(value.clientSeq) ||
    value.clientSeq < 1 ||
    !Number.isSafeInteger(value.observedAtMs) ||
    value.observedAtMs < 1 ||
    (value.status !== "active" && value.status !== "inactive")
  )
    throw new Error("invalid agent status");
}

/**
 * Refuses a wire payload over the limit its message type allows. Each codec module keeps its own
 * limit and label — the lifecycle, skills and reminder messages are capped differently (32 KiB,
 * 1 MiB, 64 KiB) — but the check and its wording are one rule, and both the encode and the decode
 * path go through it, so a peer cannot make us parse an oversized frame.
 */
export { boundedPayload, RPC_PAYLOAD_MAX_BYTES } from "./bounded-payload";

export {
  encodeWorkspaceListRequest,
  encodeWorkspaceGetRequest,
  decodeWorkspaceListRequest,
  decodeWorkspaceGetRequest,
  decodeWorkspaceListResponse,
  decodeWorkspaceGetResponse,
  encodeWorkspaceListResponse,
  encodeWorkspaceGetResponse,
  encodeComputerRegisterRequest,
  decodeComputerRegisterRequest,
  decodeComputerRegisterResponse,
  encodeComputerRegisterResponse,
} from "./workspace-codec";
