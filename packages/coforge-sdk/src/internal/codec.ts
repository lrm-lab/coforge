import { memoryHintMessage, readMemoryHint } from "./memory-hint";
import {
  decodedModelCatalog,
  decodedRuntimeMetadata,
  modelCatalog,
  runtimeMetadata,
} from "./codec-runtime-inventory";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { isMemoryAgentToolProfile } from "../agent/memory-tool-fences";
import { assertValidMessageSender, isValidMessageSender } from "./message-sender";
import {
  ComputerRegisterRequestSchema,
  ComputerRegisterResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/computer_pb";
import {
  RUNTIME_PROVIDER,
  AGENT_SESSION_INVALIDATE_REASONS,
  UPGRADE_ERROR_CODE_PATTERN,
  isChannelMessageTarget,
  requireRuntimeProvider,
  type ComputerRegisterRequest,
  type ComputerRegisterResponse,
  type RuntimeProvider,
} from "./index";
import { safeUint64 } from "./agent-observation-codec";
export { decodeAgentActivity, encodeAgentActivity } from "./agent-activity-codec";
import {
  WorkspaceGetRequestSchema,
  WorkspaceGetResponseSchema,
  WorkspaceListRequestSchema,
  WorkspaceListResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  DaemonRuntimeCodeAgentsUpdateRequestSchema,
  DaemonRuntimeReadyRequestSchema,
  DaemonRuntimeUsageScanRequestSchema,
  DaemonRuntimeUsageScanResponseSchema,
  ComputerRestartIntentSchema,
  ComputerUpgradeIntentSchema,
  ComputerUpgradeResultSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  AgentSessionReportSchema,
  AgentSessionInvalidateSchema,
  AgentStartIntentSchema,
  AgentStopIntentSchema,
  AgentActivityProbeSchema,
  AgentInboxPurgeSchema,
  AgentStatusSchema,
  AgentMessageDeliveryAckSchema,
  AgentMessageDeliveryRejectionSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import type {
  AgentSessionReport,
  AgentSessionInvalidate,
  AgentStartIntent,
  AgentStopIntent,
  AgentActivityProbe,
  AgentInboxPurge,
  AgentRuntimeProviderConfig,
  AgentRecoveryMessage,
  AgentStatus,
  AgentMessageDeliveryAck,
  AgentMessageDeliveryRejection,
  AgentMessageRequest,
} from "./index";
import {
  AGENT_START_MESSAGE_TYPE,
  AGENT_STOP_MESSAGE_TYPE,
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
import type {
  DaemonRuntimeCodeAgentsUpdateRequest,
  DaemonRuntimeReadyRequest,
  ComputerRestartIntent,
  ComputerUpgradeIntent,
  ComputerUpgradeResult,
} from "./index";
import {
  COMPUTER_RESTART_MESSAGE_TYPE,
  COMPUTER_UPGRADE_MESSAGE_TYPE,
  COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
} from "./index";

export function assertUint(value: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new Error(`invalid ${field}`);
}

const MAX_AGENT_SESSION_REPORT_BYTES = 32_768;
const MAX_AGENT_SESSION_INVALIDATE_BYTES = 32_768;

export function encodeDaemonRuntimeReadyRequest(value: DaemonRuntimeReadyRequest): Uint8Array {
  assertRunningAgentIds(value.runningAgentIds);
  return toBinary(
    DaemonRuntimeReadyRequestSchema,
    create(DaemonRuntimeReadyRequestSchema, {
      ...value,
      startedAt: BigInt(value.startedAt),
    }),
  );
}

export function decodeDaemonRuntimeReadyRequest(bytes: Uint8Array): DaemonRuntimeReadyRequest {
  const value = fromBinary(DaemonRuntimeReadyRequestSchema, bytes);
  assertRunningAgentIds(value.runningAgentIds);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    workerInstanceId: value.workerInstanceId,
    daemonVersion: value.daemonVersion,
    ...(value.computerVersion !== undefined ? { computerVersion: value.computerVersion } : {}),
    ...(value.platform !== undefined ? { platform: value.platform } : {}),
    ...(value.osVersion !== undefined ? { osVersion: value.osVersion } : {}),
    startedAt: Number(value.startedAt),
    runningAgentIds: [...value.runningAgentIds],
    recoveredRestartRequestIds: [...value.recoveredRestartRequestIds],
    recoveredUpgradeRequestIds: [...value.recoveredUpgradeRequestIds],
    ...(value.capabilities.length ? { capabilities: [...value.capabilities] } : {}),
  };
}

export function encodeComputerRestartIntent(value: ComputerRestartIntent): Uint8Array {
  return toBinary(
    ComputerRestartIntentSchema,
    create(ComputerRestartIntentSchema, { ...value, messageType: COMPUTER_RESTART_MESSAGE_TYPE }),
  );
}

export function decodeComputerRestartIntent(bytes: Uint8Array): ComputerRestartIntent {
  const value = fromBinary(ComputerRestartIntentSchema, bytes);
  if (value.messageType !== COMPUTER_RESTART_MESSAGE_TYPE)
    throw new Error("invalid Computer restart message type");
  if (!value.requestId || !value.workspaceId || !value.computerId)
    throw new Error("invalid Computer restart intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    messageType: COMPUTER_RESTART_MESSAGE_TYPE,
  };
}

export function encodeComputerUpgradeIntent(value: ComputerUpgradeIntent): Uint8Array {
  return toBinary(
    ComputerUpgradeIntentSchema,
    create(ComputerUpgradeIntentSchema, {
      ...value,
      target: "latest",
      ...(value.expectedVersion ? { expectedVersion: value.expectedVersion } : {}),
      messageType: COMPUTER_UPGRADE_MESSAGE_TYPE,
    }),
  );
}

export function decodeComputerUpgradeIntent(bytes: Uint8Array): ComputerUpgradeIntent {
  const value = fromBinary(ComputerUpgradeIntentSchema, bytes);
  if (
    value.messageType !== COMPUTER_UPGRADE_MESSAGE_TYPE ||
    value.target !== "latest" ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId
  )
    throw new Error("invalid Computer upgrade intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    target: "latest",
    ...(value.expectedVersion ? { expectedVersion: value.expectedVersion } : {}),
    messageType: COMPUTER_UPGRADE_MESSAGE_TYPE,
  };
}

/** How much reported failure text the protocol carries. */
const UPGRADE_ERROR_LIMIT = 300;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)[^\s"'`]{2,}/g;
const SECRET_LIKE = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Upgrade failures are rendered to Workspace members, so the text that leaves the machine must
 * not carry local filesystem layout or anything shaped like a credential. Both ends apply this:
 * the Daemon before it reports, the server before it stores.
 */
export function sanitizeUpgradeErrorText(value: string): string {
  return value
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(SECRET_LIKE, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, UPGRADE_ERROR_LIMIT);
}

export function encodeComputerUpgradeResult(value: ComputerUpgradeResult): Uint8Array {
  if (value.status !== "succeeded" && value.status !== "failed")
    throw new Error("invalid Computer upgrade result status");
  if (value.errorCode !== undefined && !UPGRADE_ERROR_CODE_PATTERN.test(value.errorCode))
    throw new Error("invalid Computer upgrade result error code");
  return toBinary(
    ComputerUpgradeResultSchema,
    create(ComputerUpgradeResultSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      status: value.status,
      completedAtMs: BigInt(Math.trunc(value.completedAtMs)),
      messageType: COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
      ...(value.version ? { version: value.version } : {}),
      ...(value.error ? { error: sanitizeUpgradeErrorText(value.error) } : {}),
      ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    }),
  );
}

export function decodeComputerUpgradeResult(bytes: Uint8Array): ComputerUpgradeResult {
  const value = fromBinary(ComputerUpgradeResultSchema, bytes);
  if (
    value.messageType !== COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    (value.status !== "succeeded" && value.status !== "failed")
  )
    throw new Error("invalid Computer upgrade result");
  const completedAtMs = Number(value.completedAtMs);
  if (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0)
    throw new Error("invalid Computer upgrade result completion time");
  // The shape is enforced (a malformed value is a decode failure); membership in the known
  // vocabulary is not - a newer peer's code this build has not learned about yet must still
  // arrive intact rather than being dropped or rejected.
  if (value.errorCode !== undefined && !UPGRADE_ERROR_CODE_PATTERN.test(value.errorCode))
    throw new Error("invalid Computer upgrade result error code");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    status: value.status,
    completedAtMs,
    ...(value.version ? { version: value.version } : {}),
    ...(value.error ? { error: sanitizeUpgradeErrorText(value.error) } : {}),
    ...(value.errorCode ? { errorCode: value.errorCode } : {}),
    messageType: COMPUTER_UPGRADE_RESULT_MESSAGE_TYPE,
  };
}

function assertRunningAgentIds(agentIds: readonly string[]): void {
  if (agentIds.some((agentId) => !agentId) || new Set(agentIds).size !== agentIds.length)
    throw new Error("Daemon running Agent IDs must be non-empty and unique");
}

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

/** The longest resume or introduction prompt a start intent carries, in UTF-16 code units. */
export const AGENT_START_PROMPT_MAX_LENGTH = 8192;

function assertStartPrompt(
  name: "resume" | "introduction",
  prompt: string | undefined,
  error: (reason: string) => Error,
) {
  if (prompt === undefined) return;
  if (!prompt.trim()) throw error(`blank ${name} prompt`);
  if (prompt.length > AGENT_START_PROMPT_MAX_LENGTH) throw error(`${name} prompt is too long`);
}

function assertResumePrompt(
  prompt: string | undefined,
  hasRecovery: boolean,
  error: (reason: string) => Error,
) {
  assertStartPrompt("resume", prompt, error);
  if (prompt !== undefined && hasRecovery)
    throw error("resume prompt cannot carry message recovery");
}

export function encodeAgentStartIntent(value: AgentStartIntent): Uint8Array {
  assertResumePrompt(
    value.resumePrompt,
    Boolean(
      value.wakeMessage ||
      value.resumeMessages?.length ||
      Object.keys(value.unreadSummary ?? {}).length,
    ),
    (reason) => new Error(`invalid Agent start ${reason}`),
  );
  assertStartPrompt(
    "introduction",
    value.introductionPrompt,
    (reason) => new Error(`invalid Agent start ${reason}`),
  );
  if (value.controlEpoch !== undefined)
    assertPositiveControlCounter(value.controlEpoch, "Agent control epoch");
  // The server mints and supplies launchId for every managed (controlEpoch-carrying)
  // start; a start intent with an epoch but no launchId is an internal bug, not a wire concern.
  if (value.controlEpoch !== undefined && !value.launchId?.trim())
    throw new Error("managed Agent start intent requires a launchId");
  if (value.launchId !== undefined && (!value.launchId.trim() || value.launchId.length > 512))
    throw new Error("invalid Agent start launchId");
  if (value.toolProfile !== undefined && !isMemoryAgentToolProfile(value.toolProfile))
    throw new Error(`unsupported Agent tool profile: ${value.toolProfile}`);
  if ((value.resumeMessages?.length ?? 0) > 100)
    throw new Error("Agent recovery resumeMessages exceeds 100");
  const recoveryMessages = [
    ...(value.wakeMessage ? [value.wakeMessage] : []),
    ...(value.resumeMessages ?? []),
  ];
  if (
    new Set(recoveryMessages.map(({ messageId }) => messageId)).size !== recoveryMessages.length ||
    new Set(recoveryMessages.map(({ deliveryId }) => deliveryId)).size !== recoveryMessages.length
  )
    throw new Error("invalid agent recovery context");
  for (const message of recoveryMessages) {
    if (!message.body) throw new Error("Agent recovery body is required");
    assertUint(message.sequence, Number.MAX_SAFE_INTEGER, "Agent recovery sequence");
    assertValidMessageSender(
      message.latestSenderKind,
      message.latestSenderHandle,
      "Agent recovery message",
    );
    if (message.createdAtMs !== undefined)
      assertUint(message.createdAtMs, Number.MAX_SAFE_INTEGER, "Agent recovery creation time");
  }
  for (const count of Object.values(value.unreadSummary ?? {}))
    assertUint(count, 0xffff_ffff, "Agent unread count");
  const providerConfig = value.providerConfig
    ? parseAgentRuntimeProviderConfig(
        value.providerConfig.kind,
        "providerId" in value.providerConfig ? value.providerConfig.providerId : undefined,
      )
    : undefined;
  return toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...value,
      // Absent means "not requested"; never send an explicit `false` for it.
      fastMode: value.fastMode ? true : undefined,
      providerConfig: providerConfig
        ? {
            kind: providerConfig.kind,
            providerId: "providerId" in providerConfig ? providerConfig.providerId : "",
          }
        : undefined,
      messageType: AGENT_START_MESSAGE_TYPE,
      wakeMessage: value.wakeMessage
        ? {
            ...value.wakeMessage,
            sequence: BigInt(value.wakeMessage.sequence),
            createdAtMs: recoveryCreatedAt(value.wakeMessage),
            memoryHint: memoryHintMessage(value.wakeMessage.memoryHint),
          }
        : undefined,
      resumeMessages: (value.resumeMessages ?? []).map((message) => ({
        ...message,
        sequence: BigInt(message.sequence),
        createdAtMs: recoveryCreatedAt(message),
        memoryHint: memoryHintMessage(message.memoryHint),
      })),
      unreadSummary: Object.entries(value.unreadSummary ?? {}).map(([target, count]) => ({
        target,
        count,
        conversationId: value.unreadConversationIds?.[target],
      })),
    }),
  );
}
const recoveryCreatedAt = ({ createdAtMs }: AgentRecoveryMessage) =>
  createdAtMs === undefined ? undefined : BigInt(createdAtMs);
export function decodeAgentStartIntent(bytes: Uint8Array): AgentStartIntent {
  const v = fromBinary(AgentStartIntentSchema, bytes);
  if (
    v.messageType !== AGENT_START_MESSAGE_TYPE ||
    !v.requestId ||
    !v.workspaceId ||
    !v.computerId ||
    !v.agentId ||
    !v.provider
  )
    throw new Error("invalid agent start intent");
  // The provider vocabulary has one owner. A second literal list here went stale when Kiro was
  // added: every start intent for a Kiro Agent was rejected at this boundary, so it never started.
  requireRuntimeProvider(v.provider, `unsupported runtime provider: ${v.provider}`);
  if (v.controlEpoch !== undefined)
    assertPositiveControlCounter(v.controlEpoch, "Agent control epoch");
  // A managed start (one carrying controlEpoch) must carry the server-minted
  // launchId; a decoded intent that fails this is malformed, not merely "unmanaged."
  if (v.controlEpoch !== undefined && !v.launchId?.trim())
    throw new Error("invalid agent start intent: managed start requires a launchId");
  if (v.launchId !== undefined && v.launchId.length > 512)
    throw new Error("invalid agent start intent launchId");
  if (v.toolProfile !== undefined && !isMemoryAgentToolProfile(v.toolProfile))
    throw new Error(`unsupported Agent tool profile: ${v.toolProfile}`);
  const recoveryMessages = [...(v.wakeMessage ? [v.wakeMessage] : []), ...v.resumeMessages];
  const summaryTargets = new Set(v.unreadSummary.map(({ target }) => target));
  const messageIds = new Set(recoveryMessages.map(({ messageId }) => messageId));
  const deliveryIds = new Set(recoveryMessages.map(({ deliveryId }) => deliveryId));
  if (
    v.resumeMessages.length > 100 ||
    recoveryMessages.some(
      (message) =>
        !message.messageId ||
        !message.deliveryId ||
        !message.conversationId ||
        !message.body ||
        (!message.target.startsWith("@") && !isChannelMessageTarget(message.target)) ||
        message.sequence < 1n ||
        message.sequence > BigInt(Number.MAX_SAFE_INTEGER) ||
        !isValidMessageSender(message.latestSenderKind, message.latestSenderHandle),
    ) ||
    messageIds.size !== recoveryMessages.length ||
    deliveryIds.size !== recoveryMessages.length ||
    v.unreadSummary.some(
      (entry) =>
        (!entry.target.startsWith("@") && !isChannelMessageTarget(entry.target)) || entry.count < 1,
    ) ||
    summaryTargets.size !== v.unreadSummary.length
  )
    throw new Error("invalid agent recovery context");
  if (v.sessionMode !== undefined && v.sessionMode !== "create" && v.sessionMode !== "resume")
    throw new Error("invalid Agent session mode");
  if (v.sessionMode === "resume" && !v.sessionId)
    throw new Error("Agent resume requires a session ID");
  assertResumePrompt(
    v.resumePrompt,
    recoveryMessages.length > 0 || v.unreadSummary.length > 0,
    (reason) => new Error(`invalid agent start intent: ${reason}`),
  );
  assertStartPrompt(
    "introduction",
    v.introductionPrompt,
    (reason) => new Error(`invalid agent start intent: ${reason}`),
  );
  const recoveryMessage = (message: (typeof recoveryMessages)[number]) => ({
    messageId: message.messageId,
    deliveryId: message.deliveryId,
    conversationId: message.conversationId,
    sequence: Number(message.sequence),
    target: message.target,
    latestSenderKind: message.latestSenderKind as AgentRecoveryMessage["latestSenderKind"],
    latestSenderHandle: message.latestSenderHandle,
    latestSenderDescription: message.latestSenderDescription,
    body: message.body,
    ...(message.memoryHint ? { memoryHint: readMemoryHint(message.memoryHint) } : {}),
    ...(message.nonMemberMention ? { nonMemberMention: true } : {}),
    ...(message.createdAtMs !== undefined
      ? { createdAtMs: safeUint64(message.createdAtMs, "Agent recovery creation time") }
      : {}),
  });
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    agentId: v.agentId,
    provider: v.provider as AgentStartIntent["provider"],
    model: v.model,
    modelProvider: v.modelProvider,
    reasoning: v.reasoning,
    ...(v.previousLaunchId ? { previousLaunchId: v.previousLaunchId } : {}),
    providerConfig: v.providerConfig
      ? parseAgentRuntimeProviderConfig(
          v.providerConfig.kind,
          v.providerConfig.providerId || undefined,
        )
      : undefined,
    ...(v.sessionId ? { sessionId: v.sessionId } : {}),
    ...(v.sessionMode ? { sessionMode: v.sessionMode } : {}),
    ...(v.controlEpoch !== undefined ? { controlEpoch: v.controlEpoch } : {}),
    ...(v.launchId ? { launchId: v.launchId } : {}),
    ...(v.toolProfile ? { toolProfile: v.toolProfile as AgentStartIntent["toolProfile"] } : {}),
    ...(v.memoryAgent === true ? { memoryAgent: true } : {}),
    ...(v.resumePrompt !== undefined ? { resumePrompt: v.resumePrompt } : {}),
    ...(v.introductionPrompt !== undefined ? { introductionPrompt: v.introductionPrompt } : {}),
    ...(v.fastMode === true ? { fastMode: true } : {}),
    ...(v.wakeMessage ? { wakeMessage: recoveryMessage(v.wakeMessage) } : {}),
    ...(v.resumeMessages.length ? { resumeMessages: v.resumeMessages.map(recoveryMessage) } : {}),
    ...(v.unreadSummary.some((entry) => entry.conversationId)
      ? {
          unreadConversationIds: Object.fromEntries(
            v.unreadSummary
              .filter((entry) => entry.conversationId)
              .map((entry) => [entry.target, entry.conversationId!]),
          ),
        }
      : {}),
    ...(v.unreadSummary.length
      ? {
          unreadSummary: Object.fromEntries(
            v.unreadSummary.map((entry) => [entry.target, entry.count]),
          ),
        }
      : {}),
  };
}

function assertPositiveControlCounter(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 ** 31 - 1)
    throw new Error(`invalid ${field}`);
}

export function encodeAgentStopIntent(value: AgentStopIntent): Uint8Array {
  if ((value.provider === undefined) !== (value.controlEpoch === undefined))
    throw new Error("agent stop provider and control epoch must be paired");
  if (value.controlEpoch !== undefined)
    assertPositiveControlCounter(value.controlEpoch, "control epoch");
  return toBinary(
    AgentStopIntentSchema,
    create(AgentStopIntentSchema, { ...value, messageType: AGENT_STOP_MESSAGE_TYPE }),
  );
}

export function decodeAgentStopIntent(bytes: Uint8Array): AgentStopIntent {
  const value = fromBinary(AgentStopIntentSchema, bytes);
  if (
    value.messageType !== AGENT_STOP_MESSAGE_TYPE ||
    !value.requestId ||
    !value.workspaceId ||
    !value.computerId ||
    !value.agentId ||
    (value.provider === "" && value.controlEpoch !== undefined) ||
    (value.provider === undefined) !== (value.controlEpoch === undefined)
  )
    throw new Error("invalid agent stop intent");
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceId: value.workspaceId,
    computerId: value.computerId,
    agentId: value.agentId,
    ...(value.provider !== undefined
      ? {
          provider: requireRuntimeProvider(
            value.provider,
            `unsupported runtime provider: ${value.provider}`,
          ),
        }
      : {}),
    ...(value.controlEpoch !== undefined ? { controlEpoch: value.controlEpoch } : {}),
    messageType: value.messageType,
  };
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

function parseAgentRuntimeProviderConfig(
  kind: string,
  providerId: string | undefined,
): AgentRuntimeProviderConfig {
  if (kind === "default" && providerId === undefined) return { kind };
  if (kind === "coforge" && providerId) return { kind, providerId };
  throw new Error("invalid Agent runtime provider config");
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

import type { Workspace, WorkspaceQueryRequest } from "./index";

const workspaceRequest = (value: WorkspaceQueryRequest) => ({
  protocolMajor: value.protocolMajor,
  requestId: value.requestId,
  workspaceSlug: value.workspaceSlug ?? "",
});
export function encodeWorkspaceListRequest(value: WorkspaceQueryRequest) {
  return toBinary(
    WorkspaceListRequestSchema,
    create(WorkspaceListRequestSchema, workspaceRequest(value)),
  );
}
export function encodeWorkspaceGetRequest(value: WorkspaceQueryRequest) {
  return toBinary(
    WorkspaceGetRequestSchema,
    create(WorkspaceGetRequestSchema, workspaceRequest(value)),
  );
}
export function decodeWorkspaceListRequest(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceListRequestSchema, bytes);
  return v;
}
export function decodeWorkspaceGetRequest(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceGetRequestSchema, bytes);
  return v;
}
export function decodeWorkspaceListResponse(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceListResponseSchema, bytes);
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaces: v.workspaces.map(workspace),
  };
}
export function decodeWorkspaceGetResponse(bytes: Uint8Array) {
  const v = fromBinary(WorkspaceGetResponseSchema, bytes);
  if (!v.workspace) throw new Error("workspace not found");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspace: workspace(v.workspace),
  };
}
const workspace = (v: { id: string; slug: string; name: string }): Workspace => ({
  id: v.id,
  slug: v.slug,
  name: v.name,
});
export function encodeWorkspaceListResponse(value: {
  protocolMajor: number;
  requestId: string;
  workspaces: Workspace[];
}) {
  return toBinary(WorkspaceListResponseSchema, create(WorkspaceListResponseSchema, value));
}
export function encodeWorkspaceGetResponse(value: {
  protocolMajor: number;
  requestId: string;
  workspace: Workspace;
}) {
  return toBinary(WorkspaceGetResponseSchema, create(WorkspaceGetResponseSchema, value));
}

// This adapter is intentionally limited to the domain boundary: generated
// messages already use camelCase, while the domain narrows provider values and
// maps legacy/unknown enum zero values to the historical external meaning.
export function encodeComputerRegisterRequest(value: ComputerRegisterRequest): Uint8Array {
  return toBinary(
    ComputerRegisterRequestSchema,
    create(ComputerRegisterRequestSchema, {
      ...value,
    }),
  );
}

export function decodeComputerRegisterRequest(bytes: Uint8Array): ComputerRegisterRequest {
  const value = fromBinary(ComputerRegisterRequestSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    workspaceSlug: value.workspaceSlug,
    name: value.name,
    displayName: value.displayName,
    machineId: value.machineId,
    platform: value.platform,
    osVersion: value.osVersion,
    computerVersion: value.computerVersion,
    registrationIdempotencyKey: value.registrationIdempotencyKey,
  };
}

export function decodeComputerRegisterResponse(bytes: Uint8Array): ComputerRegisterResponse {
  const value = fromBinary(ComputerRegisterResponseSchema, bytes);
  return {
    protocolMajor: value.protocolMajor,
    requestId: value.requestId,
    computerId: value.computerId,
    workspaceId: value.workspaceId,
    daemonApiKey: value.daemonApiKey,
  };
}

export function encodeComputerRegisterResponse(value: ComputerRegisterResponse): Uint8Array {
  return toBinary(ComputerRegisterResponseSchema, create(ComputerRegisterResponseSchema, value));
}

/**
 * Refuses a wire payload over the limit its message type allows. Each codec module keeps its own
 * limit and label — the lifecycle, skills and reminder messages are capped differently (32 KiB,
 * 1 MiB, 64 KiB) — but the check and its wording are one rule, and both the encode and the decode
 * path go through it, so a peer cannot make us parse an oversized frame.
 */
export { boundedPayload, RPC_PAYLOAD_MAX_BYTES } from "./bounded-payload";
