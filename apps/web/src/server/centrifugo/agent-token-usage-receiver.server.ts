import { decodeAgentTokenUsage, type AgentTokenUsage } from "@lrm/coforge-sdk/internal";
import type { AgentControlStore } from "#src/server/agents/agent-control.server";
import type { AgentTokenUsageRepository } from "#src/server/db/repositories/agent-token-usage.repositories.server";
import { errorType } from "#src/server/errors/error-type.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

const MAX_PAST_SKEW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_INT32 = 2_147_483_647;

function clampRecordedAt(observedAtMs: number, nowMs: number): Date {
  const minMs = nowMs - MAX_PAST_SKEW_MS;
  const maxMs = nowMs + MAX_FUTURE_SKEW_MS;
  return new Date(Math.min(Math.max(observedAtMs, minMs), maxMs));
}

function clampOptionalInt32(value: number | undefined): number | null {
  if (value === undefined) return null;
  return Math.min(Math.max(0, Math.trunc(value)), MAX_INT32);
}

export function createAgentTokenUsageMethod(
  agents: Pick<AgentControlStore, "get">,
  repository: Pick<AgentTokenUsageRepository, "recordTurn">,
  now: () => number = Date.now,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) return rejection;
    let message: AgentTokenUsage | undefined;
    try {
      message = decodeAgentTokenUsage(payload);
    } catch {
      return { code: 400, message: "invalid Agent token usage" };
    }
    if (
      metadata.principal.workspaceId !== message.workspaceId ||
      metadata.principal.computerId !== message.computerId
    )
      return { code: 403, message: "Agent token usage scope is not authorized" };
    try {
      const agent = await agents.get(message.agentId);
      if (
        !agent ||
        agent.workspaceId !== message.workspaceId ||
        agent.computerId !== message.computerId ||
        agent.runtimeConfig.runtime !== message.provider ||
        agent.state?.launchId !== message.launchId
      )
        return new Uint8Array();
      if (message.turnSeq > MAX_INT32) return new Uint8Array();
      await repository.recordTurn({
        workspaceId: message.workspaceId,
        agentId: message.agentId,
        computerId: message.computerId,
        launchId: message.launchId,
        sessionId: message.sessionId,
        turnSeq: message.turnSeq,
        provider: message.provider,
        model: message.model,
        uncachedInputTokens: message.uncachedInputTokens,
        cacheReadTokens: message.cacheReadTokens,
        cacheWriteTokens: message.cacheWriteTokens,
        outputTokens: message.outputTokens,
        reasoningOutputTokens: message.reasoningOutputTokens ?? null,
        contextUsedTokens: clampOptionalInt32(message.contextUsedTokens),
        contextWindowTokens: clampOptionalInt32(message.contextWindowTokens),
        recordedAt: clampRecordedAt(message.observedAtMs, now()),
      });
      return new Uint8Array();
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent_token_usage:rejected",
          request_id: message.requestId,
          agent_id: message.agentId,
          workspace_id: metadata.principal.workspaceId,
          computer_id: metadata.principal.computerId,
          launch_id: message.launchId,
          turn_seq: message.turnSeq,
          reason: `unexpected: ${errorType(error)}`,
        }),
      );
      return { code: 500, message: "Agent token usage could not be recorded" };
    }
  };
}
