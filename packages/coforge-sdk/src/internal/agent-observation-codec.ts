import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentContextUsageSchema,
  AgentServiceTierSchema,
  AgentTokenUsageSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  RUNTIME_PROVIDER,
  type AgentContextUsage,
  type AgentServiceTier,
  type AgentTokenUsage,
  type RuntimeProvider,
} from "./index";
import { AGENT_SERVICE_TIER_OBSERVED, type AgentServiceTierObserved } from "./service-tier";

/** A proto `uint64` field as a JS number, refusing anything this process cannot represent. */
export function safeUint64(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`invalid ${field}`);
  return Number(value);
}

export function encodeAgentContextUsage(value: AgentContextUsage): Uint8Array {
  validateAgentContextUsage(value);
  return toBinary(
    AgentContextUsageSchema,
    create(AgentContextUsageSchema, {
      ...value,
      usedTokens: BigInt(value.usedTokens),
      windowTokens: BigInt(value.windowTokens),
      observedAtMs: BigInt(value.observedAtMs),
      clientSeq: BigInt(value.clientSeq),
    }),
  );
}

export function decodeAgentContextUsage(bytes: Uint8Array): AgentContextUsage {
  const v = fromBinary(AgentContextUsageSchema, bytes);
  const value = {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    agentId: v.agentId,
    provider: v.provider as RuntimeProvider,
    launchId: v.launchId,
    sessionId: v.sessionId,
    usedTokens: safeUint64(v.usedTokens, "context usage usedTokens"),
    windowTokens: safeUint64(v.windowTokens, "context usage windowTokens"),
    observedAtMs: safeUint64(v.observedAtMs, "context usage observedAtMs"),
    daemonInstanceId: v.daemonInstanceId,
    clientSeq: safeUint64(v.clientSeq, "context usage clientSeq"),
  };
  validateAgentContextUsage(value);
  return value;
}

function validateAgentContextUsage(value: {
  protocolMajor: number;
  provider: string;
  [key: string]: unknown;
}): asserts value is AgentContextUsage {
  if (
    value.protocolMajor !== 1 ||
    !Object.values(RUNTIME_PROVIDER).includes(value.provider as RuntimeProvider)
  )
    throw new Error("invalid context usage protocol/provider");
  for (const field of [
    "requestId",
    "workspaceId",
    "computerId",
    "agentId",
    "launchId",
    "sessionId",
    "daemonInstanceId",
  ])
    if (
      typeof value[field] !== "string" ||
      !(value[field] as string).trim() ||
      (value[field] as string).length > 512
    )
      throw new Error(`invalid context usage ${field}`);
  if (!Number.isSafeInteger(value.usedTokens) || (value.usedTokens as number) < 0)
    throw new Error("invalid context usage usedTokens");
  if (!Number.isSafeInteger(value.windowTokens) || (value.windowTokens as number) < 1)
    throw new Error("invalid context usage windowTokens");
  if (!Number.isSafeInteger(value.observedAtMs) || (value.observedAtMs as number) < 1)
    throw new Error("invalid context usage observedAtMs");
  if (!Number.isSafeInteger(value.clientSeq) || (value.clientSeq as number) < 1)
    throw new Error("invalid context usage clientSeq");
}

export function encodeAgentServiceTier(value: AgentServiceTier): Uint8Array {
  validateAgentServiceTier(value);
  return toBinary(
    AgentServiceTierSchema,
    create(AgentServiceTierSchema, {
      ...value,
      observedAtMs: BigInt(value.observedAtMs),
      clientSeq: BigInt(value.clientSeq),
    }),
  );
}

export function decodeAgentServiceTier(bytes: Uint8Array): AgentServiceTier {
  const v = fromBinary(AgentServiceTierSchema, bytes);
  const value = {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    agentId: v.agentId,
    provider: v.provider as RuntimeProvider,
    launchId: v.launchId,
    sessionId: v.sessionId,
    requested: v.requested,
    observed: v.observed as AgentServiceTierObserved,
    observedAtMs: safeUint64(v.observedAtMs, "service tier observedAtMs"),
    daemonInstanceId: v.daemonInstanceId,
    clientSeq: safeUint64(v.clientSeq, "service tier clientSeq"),
  };
  validateAgentServiceTier(value);
  return value;
}

function validateAgentServiceTier(value: {
  protocolMajor: number;
  provider: string;
  observed: string;
  [key: string]: unknown;
}): asserts value is AgentServiceTier {
  if (
    value.protocolMajor !== 1 ||
    !Object.values(RUNTIME_PROVIDER).includes(value.provider as RuntimeProvider)
  )
    throw new Error("invalid service tier protocol/provider");
  for (const field of [
    "requestId",
    "workspaceId",
    "computerId",
    "agentId",
    "launchId",
    "sessionId",
    "daemonInstanceId",
  ])
    if (
      typeof value[field] !== "string" ||
      !(value[field] as string).trim() ||
      (value[field] as string).length > 512
    )
      throw new Error(`invalid service tier ${field}`);
  if (typeof value.requested !== "boolean") throw new Error("invalid service tier requested");
  if (!Object.values(AGENT_SERVICE_TIER_OBSERVED).includes(value.observed as never))
    throw new Error("invalid service tier observed");
  if (!Number.isSafeInteger(value.observedAtMs) || (value.observedAtMs as number) < 1)
    throw new Error("invalid service tier observedAtMs");
  if (!Number.isSafeInteger(value.clientSeq) || (value.clientSeq as number) < 1)
    throw new Error("invalid service tier clientSeq");
}

export function encodeAgentTokenUsage(value: AgentTokenUsage): Uint8Array {
  validateAgentTokenUsage(value);
  return toBinary(
    AgentTokenUsageSchema,
    create(AgentTokenUsageSchema, {
      protocolMajor: value.protocolMajor,
      requestId: value.requestId,
      workspaceId: value.workspaceId,
      computerId: value.computerId,
      agentId: value.agentId,
      provider: value.provider,
      launchId: value.launchId,
      sessionId: value.sessionId,
      turnSeq: BigInt(value.turnSeq),
      model: value.model,
      uncachedInputTokens: BigInt(value.uncachedInputTokens),
      cacheReadTokens: BigInt(value.cacheReadTokens),
      cacheWriteTokens: BigInt(value.cacheWriteTokens),
      outputTokens: BigInt(value.outputTokens),
      ...(value.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: BigInt(value.reasoningOutputTokens) }
        : {}),
      ...(value.contextUsedTokens !== undefined
        ? { contextUsedTokens: BigInt(value.contextUsedTokens) }
        : {}),
      ...(value.contextWindowTokens !== undefined
        ? { contextWindowTokens: BigInt(value.contextWindowTokens) }
        : {}),
      observedAtMs: BigInt(value.observedAtMs),
      daemonInstanceId: value.daemonInstanceId,
      clientSeq: BigInt(value.clientSeq),
    }),
  );
}

export function decodeAgentTokenUsage(bytes: Uint8Array): AgentTokenUsage {
  const v = fromBinary(AgentTokenUsageSchema, bytes);
  const value = {
    protocolMajor: v.protocolMajor,
    requestId: v.requestId,
    workspaceId: v.workspaceId,
    computerId: v.computerId,
    agentId: v.agentId,
    provider: v.provider as RuntimeProvider,
    launchId: v.launchId,
    sessionId: v.sessionId,
    turnSeq: safeUint64(v.turnSeq, "token usage turnSeq"),
    model: v.model,
    uncachedInputTokens: safeUint64(v.uncachedInputTokens, "token usage uncachedInputTokens"),
    cacheReadTokens: safeUint64(v.cacheReadTokens, "token usage cacheReadTokens"),
    cacheWriteTokens: safeUint64(v.cacheWriteTokens, "token usage cacheWriteTokens"),
    outputTokens: safeUint64(v.outputTokens, "token usage outputTokens"),
    ...(v.reasoningOutputTokens !== undefined
      ? {
          reasoningOutputTokens: safeUint64(
            v.reasoningOutputTokens,
            "token usage reasoningOutputTokens",
          ),
        }
      : {}),
    ...(v.contextUsedTokens !== undefined
      ? { contextUsedTokens: safeUint64(v.contextUsedTokens, "token usage contextUsedTokens") }
      : {}),
    ...(v.contextWindowTokens !== undefined
      ? {
          contextWindowTokens: safeUint64(v.contextWindowTokens, "token usage contextWindowTokens"),
        }
      : {}),
    observedAtMs: safeUint64(v.observedAtMs, "token usage observedAtMs"),
    daemonInstanceId: v.daemonInstanceId,
    clientSeq: safeUint64(v.clientSeq, "token usage clientSeq"),
  };
  validateAgentTokenUsage(value);
  return value;
}

function validateAgentTokenUsage(value: {
  protocolMajor: number;
  provider: string;
  [key: string]: unknown;
}): asserts value is AgentTokenUsage {
  if (
    value.protocolMajor !== 1 ||
    !Object.values(RUNTIME_PROVIDER).includes(value.provider as RuntimeProvider)
  )
    throw new Error("invalid token usage protocol/provider");
  for (const field of [
    "requestId",
    "workspaceId",
    "computerId",
    "agentId",
    "launchId",
    "sessionId",
    "daemonInstanceId",
  ])
    if (
      typeof value[field] !== "string" ||
      !(value[field] as string).trim() ||
      (value[field] as string).length > 512
    )
      throw new Error(`invalid token usage ${field}`);
  if (typeof value.model !== "string" || value.model.length > 256)
    throw new Error("invalid token usage model");
  if (!Number.isSafeInteger(value.turnSeq) || (value.turnSeq as number) < 1)
    throw new Error("invalid token usage turnSeq");
  for (const field of [
    "uncachedInputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "outputTokens",
  ])
    if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0)
      throw new Error(`invalid token usage ${field}`);
  if (
    value.reasoningOutputTokens !== undefined &&
    (!Number.isSafeInteger(value.reasoningOutputTokens) ||
      (value.reasoningOutputTokens as number) < 0)
  )
    throw new Error("invalid token usage reasoningOutputTokens");
  if (
    value.contextUsedTokens !== undefined &&
    (!Number.isSafeInteger(value.contextUsedTokens) || (value.contextUsedTokens as number) < 0)
  )
    throw new Error("invalid token usage contextUsedTokens");
  if (
    value.contextWindowTokens !== undefined &&
    (!Number.isSafeInteger(value.contextWindowTokens) || (value.contextWindowTokens as number) < 1)
  )
    throw new Error("invalid token usage contextWindowTokens");
  if (!Number.isSafeInteger(value.observedAtMs) || (value.observedAtMs as number) < 1)
    throw new Error("invalid token usage observedAtMs");
  if (!Number.isSafeInteger(value.clientSeq) || (value.clientSeq as number) < 1)
    throw new Error("invalid token usage clientSeq");
}
