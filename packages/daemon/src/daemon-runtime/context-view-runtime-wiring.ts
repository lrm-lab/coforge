import type {
  AgentContextViewService,
  ContextViewAgentFacts,
} from "#src/agent-context-view/agent-context-view-service";
import { contextViewTranscriptSource } from "#src/agent-context-view/context-view-session-source";
import {
  findProviderTranscript,
  resolveProviderTranscriptToken,
} from "#src/agent-context-view/context-view-provider-locator";
import type { AgentMessageDelivery, AgentSessionReport } from "@lrm/coforge-sdk/internal";
import type { AgentSession } from "@coforge/agent";

export type ContextViewRuntimeDeps = {
  service: AgentContextViewService;
  enabled: Map<string, boolean>;
  runtime(
    agentId: string,
  ):
    | { config: { provider: string; envVars?: Record<string, string> }; session?: unknown }
    | undefined;
  restartConfig(agentId: string): { config: { envVars?: Record<string, string> } } | undefined;
  workspaceRoot: string;
  reported(agentId: string): { sessionId?: string } | undefined;
};

export function setContextViewMessageIds(
  session: Pick<AgentSession, "setContextViewMessageId" | "setContextViewMessageIds">,
  messageIds: readonly string[],
): void {
  if (session.setContextViewMessageIds) session.setContextViewMessageIds(messageIds);
  else session.setContextViewMessageId?.(messageIds.at(-1));
}

export async function deliverContextViewMessage(
  deps: ContextViewRuntimeDeps,
  agentId: string,
  message: AgentMessageDelivery,
  deliver: () => Promise<void>,
): Promise<void> {
  if (message.features?.agentContextView !== undefined)
    applyContextViewGate(deps, agentId, message.features.agentContextView);
  await deliver();
  commitContextViewMessage(deps, agentId, message, await contextViewTranscriptPath(deps, agentId));
}

export function applyContextViewGate(
  deps: Pick<ContextViewRuntimeDeps, "service" | "enabled">,
  agentId: string,
  enabled: boolean | undefined,
): void {
  if (enabled === undefined) return;
  deps.enabled.set(agentId, enabled);
  if (enabled) deps.service.enable(agentId);
  else deps.service.disable(agentId);
}

export function resolveContextViewProviderSource(
  deps: Pick<ContextViewRuntimeDeps, "runtime" | "restartConfig">,
  agentId: string,
  entry: { runtime: string; transcript: string },
): string | undefined {
  const runtime = deps.runtime(agentId);
  const envVars = runtime?.config.envVars ?? deps.restartConfig(agentId)?.config.envVars;
  return resolveProviderTranscriptToken(entry.runtime, entry.transcript, envVars);
}

export async function contextViewTranscriptPath(
  deps: Pick<ContextViewRuntimeDeps, "runtime" | "restartConfig" | "workspaceRoot" | "reported">,
  agentId: string,
): Promise<{ absolute: string; relative: string } | undefined> {
  const runtime = deps.runtime(agentId);
  const local = contextViewTranscriptSource(runtime?.session, deps.workspaceRoot);
  if (local) return local;
  const sessionId = deps.reported(agentId)?.sessionId;
  if (!sessionId || !runtime) return undefined;
  const envVars = runtime.config.envVars ?? deps.restartConfig(agentId)?.config.envVars;
  return findProviderTranscript(runtime.config.provider, sessionId, envVars);
}

export function commitContextViewMessage(
  deps: ContextViewRuntimeDeps,
  agentId: string,
  message: AgentMessageDelivery,
  transcriptPath: { absolute: string; relative: string } | undefined,
): void {
  const runtime = deps.runtime(agentId);
  const session = deps.reported(agentId);
  const facts: ContextViewAgentFacts = {
    agentId,
    runtime: runtime?.config.provider ?? "",
    sessionId: session?.sessionId,
    ...(transcriptPath
      ? { transcript: transcriptPath.relative, transcriptPath: transcriptPath.absolute }
      : {}),
  };
  deps.service.onMessageCommitted(facts, message.messageId, deps.enabled.get(agentId) === true);
}

export async function reportContextViewAvailability(
  deps: ContextViewRuntimeDeps,
  report: AgentSessionReport,
): Promise<void> {
  const path = await contextViewTranscriptPath(deps, report.agentId);
  deps.service.reportAvailability(
    {
      agentId: report.agentId,
      runtime: report.provider,
      sessionId: report.sessionId,
      ...(path ? { transcript: path.relative, transcriptPath: path.absolute } : {}),
    },
    deps.enabled.get(report.agentId) === true,
  );
}
