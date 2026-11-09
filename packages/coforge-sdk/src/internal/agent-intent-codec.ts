import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { isMemoryAgentToolProfile } from "../agent/memory-tool-fences";
import { assertPositiveControlCounter, assertUint } from "./codec";
import { safeUint64 } from "./agent-observation-codec";
import { memoryHintMessage, readMemoryHint } from "./memory-hint";
import { assertValidMessageSender, isValidMessageSender } from "./message-sender";
import {
  AGENT_START_MESSAGE_TYPE,
  AGENT_STOP_MESSAGE_TYPE,
  isRecoverableAgentTarget,
  requireRuntimeProvider,
} from "./index";
import type {
  AgentRecoveryMessage,
  AgentRuntimeProviderConfig,
  AgentStartIntent,
  AgentStopIntent,
} from "./index";
import {
  AgentStartIntentSchema,
  AgentStopIntentSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";

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
  if (value.agentConfigRevision !== undefined)
    assertPositiveControlCounter(value.agentConfigRevision, "Agent config revision");
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
  if (v.agentConfigRevision !== undefined)
    assertPositiveControlCounter(v.agentConfigRevision, "Agent config revision");
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
        !isRecoverableAgentTarget(message.target) ||
        message.sequence < 1n ||
        message.sequence > BigInt(Number.MAX_SAFE_INTEGER) ||
        !isValidMessageSender(message.latestSenderKind, message.latestSenderHandle),
    ) ||
    messageIds.size !== recoveryMessages.length ||
    deliveryIds.size !== recoveryMessages.length ||
    v.unreadSummary.some((entry) => !isRecoverableAgentTarget(entry.target) || entry.count < 1) ||
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
    ...(v.agentConfigRevision !== undefined ? { agentConfigRevision: v.agentConfigRevision } : {}),
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

function parseAgentRuntimeProviderConfig(
  kind: string,
  providerId: string | undefined,
): AgentRuntimeProviderConfig {
  if (kind === "default" && providerId === undefined) return { kind };
  if (kind === "coforge" && providerId) return { kind, providerId };
  throw new Error("invalid Agent runtime provider config");
}
