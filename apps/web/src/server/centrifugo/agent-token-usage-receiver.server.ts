import { decodeAgentTokenUsage, type AgentTokenUsage } from "@lrm/coforge-sdk/internal";
import { agentStatusChannelFor } from "#src/features/agents/agent-status-channel";
import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { AgentTokenUsageRepository } from "#src/server/db/repositories/agent-token-usage.repositories.server";
import { errorType } from "#src/server/errors/error-type.server";
import { rejectNonDaemonPrincipal } from "./daemon-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";
import type { CentrifugoServerApi } from "./server-api.server";

export type AgentTokenUsageAgentLookup = {
  get(agentId: string): Promise<
    | {
        workspaceId: string;
        computerId: string | null;
        visibility?: string;
      }
    | undefined
  >;
};

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

function logTokenUsageOutcome(
  event:
    | "agent_token_usage:dropped"
    | "agent_token_usage:rejected"
    | "agent_token_usage:publish_failed",
  details: {
    requestId?: string;
    agentId?: string;
    workspaceId?: string;
    computerId?: string;
    launchId?: string;
    turnSeq?: number;
    reason: string;
  },
): void {
  console.warn(
    JSON.stringify({
      event,
      request_id: details.requestId,
      agent_id: details.agentId,
      workspace_id: details.workspaceId,
      computer_id: details.computerId,
      launch_id: details.launchId,
      turn_seq: details.turnSeq,
      reason: details.reason,
    }),
  );
}

export function createAgentTokenUsageMethod(
  agents: AgentTokenUsageAgentLookup,
  repository: Pick<AgentTokenUsageRepository, "recordTurn">,
  now: () => number = Date.now,
  events?: Pick<CentrifugoServerApi, "publishJson">,
): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const rejection = rejectNonDaemonPrincipal(metadata.principal);
    if (rejection) {
      logTokenUsageOutcome("agent_token_usage:rejected", {
        workspaceId: metadata.principal.workspaceId,
        computerId: metadata.principal.computerId,
        reason: "non_daemon_principal",
      });
      return rejection;
    }
    let message: AgentTokenUsage | undefined;
    try {
      message = decodeAgentTokenUsage(payload);
    } catch {
      logTokenUsageOutcome("agent_token_usage:rejected", {
        workspaceId: metadata.principal.workspaceId,
        computerId: metadata.principal.computerId,
        reason: "invalid_payload",
      });
      return { code: 400, message: "invalid Agent token usage" };
    }
    const logMessageOutcome = (
      event:
        | "agent_token_usage:dropped"
        | "agent_token_usage:rejected"
        | "agent_token_usage:publish_failed",
      reason: string,
    ) => {
      logTokenUsageOutcome(event, {
        requestId: message.requestId,
        agentId: message.agentId,
        workspaceId: metadata.principal.workspaceId,
        computerId: metadata.principal.computerId,
        launchId: message.launchId,
        turnSeq: message.turnSeq,
        reason,
      });
    };
    if (
      metadata.principal.workspaceId !== message.workspaceId ||
      metadata.principal.computerId !== message.computerId
    ) {
      logMessageOutcome("agent_token_usage:rejected", "scope_mismatch");
      return { code: 403, message: "Agent token usage scope is not authorized" };
    }
    try {
      const agent = await agents.get(message.agentId);
      if (!agent) {
        logMessageOutcome("agent_token_usage:dropped", "agent_not_found");
        return new Uint8Array();
      }
      if (agent.workspaceId !== message.workspaceId || agent.computerId !== message.computerId) {
        logMessageOutcome("agent_token_usage:dropped", "agent_scope_mismatch");
        return new Uint8Array();
      }
      if (message.turnSeq > MAX_INT32) {
        logMessageOutcome("agent_token_usage:dropped", "turn_seq_overflow");
        return new Uint8Array();
      }
      const inserted = await repository.recordTurn({
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
      if (inserted && events && agent.visibility !== undefined) {
        const channel = agentStatusChannelFor(
          message.workspaceId,
          message.agentId,
          agent.visibility,
        );
        try {
          await events.publishJson(channel, {
            type: REALTIME_EVENTS.agentTokenUsageRecorded,
            agentId: message.agentId,
          });
        } catch (error) {
          logMessageOutcome("agent_token_usage:publish_failed", `unexpected: ${errorType(error)}`);
        }
      }
      return new Uint8Array();
    } catch (error) {
      logMessageOutcome("agent_token_usage:rejected", `unexpected: ${errorType(error)}`);
      return { code: 500, message: "Agent token usage could not be recorded" };
    }
  };
}
