import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { assertPositiveControlCounter, assertUint } from "./codec";
import { safeUint64 } from "./agent-observation-codec";
import {
  assertAgentRecoveryContext,
  assertAgentStartOpenTasks,
  normalizeAgentStartOpenTasks,
} from "./agent-recovery-context";
import { AGENT_START_MESSAGE_TYPE, AGENT_STOP_MESSAGE_TYPE, requireRuntimeProvider } from "./index";
import type {
  AgentControlScope,
  AgentRecoveryMessage,
  AgentRuntimeProviderConfig,
  AgentStartIntent,
  AgentStopIntent,
} from "./index";
import {
  AgentStartIntentSchema,
  AgentStopIntentSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
export const AGENT_START_PROMPT_MAX_LENGTH = 8192;
const MAX_LAUNCH_SIZE = 10000000;
function assertLaunchSize(
  name: string,
  value: number | undefined,
  error: (reason: string) => Error,
) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LAUNCH_SIZE)
    throw error(`${name} is out of range`);
}
function launchSize(value: number | undefined) {
  return value !== undefined && value >= 1 && value <= MAX_LAUNCH_SIZE ? value : undefined;
}
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
function unreadSequenceProof(
  sequence: number | undefined,
  count: number,
  conversationId: string | undefined,
): number | undefined {
  if (sequence === undefined || !Number.isSafeInteger(sequence)) return;
  if (!conversationId?.trim() || count < 1 || sequence < count) return;
  return sequence;
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
  if (value.controlEpoch !== undefined && !value.launchId?.trim())
    throw new Error("managed Agent start intent requires a launchId");
  if (value.launchId !== undefined && (!value.launchId.trim() || value.launchId.length > 512))
    throw new Error("invalid Agent start launchId");
  if (value.agentConfigRevision !== undefined)
    assertPositiveControlCounter(value.agentConfigRevision, "Agent config revision");
  const launchError = (reason: string) => new Error(`invalid Agent start ${reason}`);
  assertLaunchSize("context window", value.contextWindow, launchError);
  assertLaunchSize("maximum output", value.maxOutputTokens, launchError);
  const recoveryMessages = [
    ...(value.wakeMessage ? [value.wakeMessage] : []),
    ...(value.resumeMessages ?? []),
  ];
  assertAgentRecoveryContext({
    wakeMessage: value.wakeMessage,
    resumeMessages: value.resumeMessages ?? [],
    unreadSummary: Object.entries(value.unreadSummary ?? {}).map(([target, count]) => ({
      target,
      count,
    })),
  });
  for (const message of recoveryMessages)
    if (message.createdAtMs !== undefined)
      assertUint(message.createdAtMs, Number.MAX_SAFE_INTEGER, "Agent recovery creation time");
  const providerConfig = value.providerConfig
    ? parseAgentRuntimeProviderConfig(
        value.providerConfig.kind,
        "providerId" in value.providerConfig ? value.providerConfig.providerId : undefined,
      )
    : undefined;
  const openTasks = assertAgentStartOpenTasks(value.openTasks);
  return toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...value,
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
          }
        : undefined,
      resumeMessages: (value.resumeMessages ?? []).map((message) => ({
        ...message,
        sequence: BigInt(message.sequence),
        createdAtMs: recoveryCreatedAt(message),
      })),
      unreadSummary: Object.entries(value.unreadSummary ?? {}).map(([target, count]) => {
        const conversationId = value.unreadConversationIds?.[target];
        const sequence = unreadSequenceProof(
          value.lastUnreadSequences?.[target],
          count,
          conversationId,
        );
        return {
          target,
          count,
          conversationId,
          lastUnreadSequence: sequence === undefined ? undefined : BigInt(sequence),
        };
      }),
      openTasks,
    }),
  );
}
const recoveryCreatedAt = ({ createdAtMs }: AgentRecoveryMessage) =>
  createdAtMs === undefined ? undefined : BigInt(createdAtMs);
export function decodeAgentStartIntentScope(bytes: Uint8Array): AgentControlScope | undefined {
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
  const provider = requireRuntimeProvider(
    v.provider,
    `unsupported runtime provider: ${v.provider}`,
  );
  if (v.controlEpoch === undefined) return undefined;
  assertPositiveControlCounter(v.controlEpoch, "Agent control epoch");
  return {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    agentId: v.agentId,
    provider,
    epoch: v.controlEpoch,
  };
}

export function decodeAgentStartIntent(bytes: Uint8Array): AgentStartIntent {
  const v = fromBinary(AgentStartIntentSchema, bytes);
  if (v.$unknown?.some((field) => field.no === 21 || field.no === 22))
    throw new Error("retired Memory Agent launch");
  if (
    v.messageType !== AGENT_START_MESSAGE_TYPE ||
    !v.requestId ||
    !v.workspaceId ||
    !v.computerId ||
    !v.agentId ||
    !v.provider
  )
    throw new Error("invalid agent start intent");
  requireRuntimeProvider(v.provider, `unsupported runtime provider: ${v.provider}`);
  if (v.controlEpoch !== undefined)
    assertPositiveControlCounter(v.controlEpoch, "Agent control epoch");
  if (v.controlEpoch !== undefined && !v.launchId?.trim())
    throw new Error("invalid agent start intent: managed start requires a launchId");
  if (v.launchId !== undefined && v.launchId.length > 512)
    throw new Error("invalid agent start intent launchId");
  if (v.agentConfigRevision !== undefined)
    assertPositiveControlCounter(v.agentConfigRevision, "Agent config revision");
  const sizes = {
    contextWindow: launchSize(v.contextWindow),
    maxOutputTokens: launchSize(v.maxOutputTokens),
  };
  const recoveryMessages = [...(v.wakeMessage ? [v.wakeMessage] : []), ...v.resumeMessages];
  assertAgentRecoveryContext({
    wakeMessage: v.wakeMessage && { ...v.wakeMessage, sequence: Number(v.wakeMessage.sequence) },
    resumeMessages: v.resumeMessages.map((m) => ({ ...m, sequence: Number(m.sequence) })),
    unreadSummary: v.unreadSummary,
  });
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
    ...(message.nonMemberMention ? { nonMemberMention: true } : {}),
    ...(message.createdAtMs !== undefined
      ? { createdAtMs: safeUint64(message.createdAtMs, "Agent recovery creation time") }
      : {}),
  });
  const openTasks = normalizeAgentStartOpenTasks(v.openTasks);
  const sequenceProofs = v.unreadSummary.flatMap((entry) => {
    const sequence = unreadSequenceProof(
      Number(entry.lastUnreadSequence),
      entry.count,
      entry.conversationId,
    );
    return sequence === undefined ? [] : [[entry.target, sequence] as const];
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
    ...(v.resumePrompt !== undefined ? { resumePrompt: v.resumePrompt } : {}),
    ...(v.introductionPrompt !== undefined ? { introductionPrompt: v.introductionPrompt } : {}),
    ...(v.fastMode === true ? { fastMode: true } : {}),
    ...(v.agentConfigRevision !== undefined ? { agentConfigRevision: v.agentConfigRevision } : {}),
    ...(sizes.contextWindow !== undefined ? { contextWindow: sizes.contextWindow } : {}),
    ...(sizes.maxOutputTokens !== undefined ? { maxOutputTokens: sizes.maxOutputTokens } : {}),
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
    ...(sequenceProofs.length ? { lastUnreadSequences: Object.fromEntries(sequenceProofs) } : {}),
    ...(openTasks ? { openTasks } : {}),
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
