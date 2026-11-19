import { getLogger } from "@logtape/logtape";
import {
  AGENT_SIDE_ASK_FORK_MAX_CONTEXT_TOKENS,
  RUNTIME_PROVIDER,
  type AgentSideAskFailureReason,
  type AgentSideAskResult,
} from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig, AgentRuntime } from "#src/agent-runtime/agent-process-manager";
import { formatSideAskStatus, type SideQuestionRunner } from "#src/agent-runtime/agent-side-ask";
import {
  readClaudeSideAskState,
  type ClaudeSideAskTranscriptState,
} from "#src/code-agent/claude-code/side-ask-state";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import type { DaemonConnectionClient } from "#src/connection/daemon-connection-client";
import type { ActivityLaunch } from "./activity-launch";
import type { AgentActivityPublisher } from "./agent-activity-publisher";
import type { CredentialInvalidHolds } from "./credential-invalid-holds";
import type { ProviderQuotaState } from "./provider-quota-state";
import type { DaemonConfig } from "./runtime";

const logger = getLogger(["coforge", "daemon", "side-ask"]);

export type AgentSideAskSource = {
  runtime(agentId: string): AgentRuntime | undefined;
  restartConfig(agentId: string): AgentRestartConfig | undefined;
  currentActivityLaunch(agentId: string): ActivityLaunch | undefined;
  stopping(agentId: string): boolean;
  reported(agentId: string): Readonly<{ launchId: string; sessionId: string }> | undefined;
  onRuntimeEnd(listener: (agentId: string) => void): () => void;
};

export type AgentSideAskHandlerPorts = {
  connection: DaemonConfig;
  source: AgentSideAskSource;
  activityPublisher: Pick<AgentActivityPublisher<ActivityLaunch>, "lastBusy">;
  credentialHolds: Pick<CredentialInvalidHolds, "isHeld">;
  quotaState?: Pick<ProviderQuotaState, "summaryForAgent">;
  runner: Pick<SideQuestionRunner, "ask"> & Partial<Pick<SideQuestionRunner, "hasInFlight">>;
  currentTransport(): DaemonConnectionClient;
  isStopping(): boolean;
  readClaudeState?: (
    sessionId: string,
    envVars: Readonly<Record<string, string>> | undefined,
  ) => Promise<ClaudeSideAskTranscriptState | undefined>;
  now?: () => number;
};

export function subscribeAgentSideAskQueries(
  transport: DaemonConnectionClient,
  ports: AgentSideAskHandlerPorts,
): (() => void) | undefined {
  const readClaudeState = ports.readClaudeState ?? readClaudeSideAskState;
  const now = ports.now ?? Date.now;

  return transport.onAgentSideAsk?.(async (request) => {
    if (
      ports.isStopping() ||
      request.workspaceId !== ports.connection.workspaceId ||
      request.computerId !== ports.connection.computerId
    )
      return;

    const startedAt = now();
    const send = async (
      partial:
        | { status: "ok"; answer: string; runtime?: string }
        | { status: "failed"; reason: AgentSideAskFailureReason; runtime?: string },
    ): Promise<void> => {
      const durationMs = Math.max(0, Math.min(600_000, now() - startedAt));
      const result: AgentSideAskResult = {
        protocolMajor: request.protocolMajor,
        requestId: request.requestId,
        workspaceId: request.workspaceId,
        computerId: request.computerId,
        agentId: request.agentId,
        askerUserId: request.asker.userId,
        kind: request.kind,
        status: partial.status,
        ...(partial.status === "failed" ? { reason: partial.reason } : {}),
        answer: partial.status === "ok" ? partial.answer : "",
        ...(partial.runtime ? { runtime: partial.runtime } : {}),
        durationMs,
      };
      logger.info("Agent side ask finished", {
        event: "agent_side_ask:result",
        request_id: request.requestId,
        agent_id: request.agentId,
        kind: request.kind,
        ...(partial.runtime ? { runtime: partial.runtime } : {}),
        status: partial.status,
        ...(partial.status === "failed" ? { reason: partial.reason } : {}),
        duration_ms: durationMs,
      });
      if (ports.isStopping() || ports.currentTransport() !== transport) return;
      try {
        await transport.sendAgentSideAskResult?.(result);
      } catch (error) {
        logger.warning("Agent side ask result delivery failed", {
          event: "agent_side_ask:result_send_failed",
          request_id: request.requestId,
          agent_id: request.agentId,
          error_code: error instanceof Error ? error.name : "unknown",
        });
      }
    };

    const runtime = ports.source.runtime(request.agentId);
    const launch = ports.source.currentActivityLaunch(request.agentId);
    if (!runtime || ports.source.stopping(request.agentId) || launch?.stopping) {
      await send({ status: "failed", reason: "agent_not_running" });
      return;
    }

    const provider = runtime.config.provider;
    const reported = ports.source.reported(request.agentId);
    const reportedSessionId =
      reported && launch && reported.launchId === launch.launchId ? reported.sessionId : undefined;
    const sessionId = reportedSessionId ?? ports.source.restartConfig(request.agentId)?.sessionId;

    if (request.kind === "status") {
      const busy = ports.activityPublisher.lastBusy(request.agentId);
      const currentBusy = busy && launch && busy.launch === launch ? busy : undefined;
      const openTool = launch?.toolCalls?.oldestOpenTool();
      const quotaWarning = ports.quotaState?.summaryForAgent(request.agentId, provider);
      const claudeState =
        provider === RUNTIME_PROVIDER.CLAUDE_CODE && sessionId
          ? await readClaudeState(sessionId, runtime.config.envVars).catch(() => undefined)
          : undefined;
      const answer = formatSideAskStatus({
        runtime: provider,
        ...(currentBusy
          ? {
              busyDetailKind: currentBusy.activity.detailKind,
              busyDetail: currentBusy.activity.detail,
              busyElapsedMs: Math.max(0, now() - currentBusy.at),
            }
          : {}),
        ...(openTool ? { openTool } : {}),
        ...(quotaWarning ? { quotaWarning } : {}),
        ...(claudeState
          ? {
              todos: claudeState.openTodos,
              openTodoCount: claudeState.openTodoCount,
              totalTodos: claudeState.totalTodos,
              latestNote: claudeState.latestNote,
            }
          : {}),
      });
      await send({ status: "ok", answer, runtime: provider });
      return;
    }

    if (provider !== RUNTIME_PROVIDER.CLAUDE_CODE) {
      await send({ status: "failed", reason: "unsupported_runtime", runtime: provider });
      return;
    }

    if (ports.credentialHolds.isHeld(request.agentId)) {
      await send({ status: "failed", reason: "usage_limited", runtime: provider });
      return;
    }

    if (!sessionId) {
      await send({ status: "failed", reason: "agent_not_running", runtime: provider });
      return;
    }

    if (ports.runner.hasInFlight?.(request.agentId)) {
      await send({ status: "failed", reason: "busy", runtime: provider });
      return;
    }

    const claudeState = await readClaudeState(sessionId, runtime.config.envVars).catch(
      () => undefined,
    );
    if (!claudeState) {
      await send({ status: "failed", reason: "agent_not_running", runtime: provider });
      return;
    }

    const contextTokens = launch?.lastContextTokens ?? claudeState.contextTokens;
    if (contextTokens !== undefined && contextTokens > AGENT_SIDE_ASK_FORK_MAX_CONTEXT_TOKENS) {
      await send({ status: "failed", reason: "context_too_large", runtime: provider });
      return;
    }

    if (
      ports.isStopping() ||
      ports.source.runtime(request.agentId) !== runtime ||
      ports.source.currentActivityLaunch(request.agentId) !== launch ||
      ports.source.stopping(request.agentId) ||
      launch?.stopping
    ) {
      await send({ status: "failed", reason: "agent_not_running", runtime: provider });
      return;
    }

    const outcome = await ports.runner.ask({
      agentId: request.agentId,
      sessionId,
      model: runtime.config.model,
      envVars: runtime.config.envVars,
      workingDirectory: agentWorkspaceDirectory(
        ports.connection.workspaceRoot,
        ports.connection.workspaceId,
        request.agentId,
      ),
      question: request.question,
      asker: request.asker,
      timeoutMs: request.timeoutMs,
    });
    if (outcome.ok) await send({ status: "ok", answer: outcome.answer, runtime: provider });
    else await send({ status: "failed", reason: outcome.reason, runtime: provider });
  });
}
