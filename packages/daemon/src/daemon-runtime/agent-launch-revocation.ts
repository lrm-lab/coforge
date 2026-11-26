import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { PublishedActivityLaunch } from "./agent-activity-publisher";
import type { AgentProxy } from "./runtime-launch-types";
import { restoreSupersededAgentApiKey } from "./agent-api-key-revoke";
import { logAgentApiKeyRevokeFailed } from "./agent-failure-logs";

/** Drops the Agent's issued local context and proxy token, only when the maps still hold exactly
 * the pair being revoked — a relaunched Agent's newer pair is never touched. With no pair the
 * tables' current one and the Agent's proxy registration are revoked; a caller that passes any
 * part of its own pair (even a launch that issued only a context) revokes exactly that, never
 * values another process still uses. */
export function revokeLocalLaunch(
  contexts: Map<string, string>,
  proxyTokens: Map<string, string>,
  proxy: AgentProxy | undefined,
  agentId: string,
  context?: string,
  proxyToken?: string,
): void {
  if (context === undefined && proxyToken === undefined) {
    context = contexts.get(agentId);
    proxyToken = proxyTokens.get(agentId);
    proxy?.revokeAgent?.(agentId);
  }
  if (context && contexts.get(agentId) === context) contexts.delete(agentId);
  if (proxyToken && proxyTokens.get(agentId) === proxyToken) proxyTokens.delete(agentId);
  if (proxyToken) proxy?.revoke(proxyToken);
}

/**
 * Puts back the proxy token a still-running process holds after a launch that overwrote it
 * failed — but only while the table still holds the failed launch's token, so a concurrent
 * launch's newer token is never clobbered. With no prior token the entry is removed, which is
 * the same outcome the revoke leaves when it runs alone.
 */
export function restoreSupersededProxyToken(
  proxyTokens: Map<string, string>,
  agentId: string,
  supersededToken: string | undefined,
  restoredToken: string | undefined,
): void {
  if (supersededToken === undefined || proxyTokens.get(agentId) !== supersededToken) return;
  if (restoredToken === undefined) proxyTokens.delete(agentId);
  else proxyTokens.set(agentId, restoredToken);
}

export function restoreFailedLaunchAuthorization(
  ports: {
    agentProxyTokens: Map<string, string>;
    agentApiKeys: Map<string, string>;
    revokeLocalLaunch(agentId: string, context?: string, token?: string): void;
    revokeAgentApiKey(agentId: string, key: string | undefined): Promise<void>;
  },
  agentId: string,
  {
    issuedProxyToken,
    localContext,
    proxyToken,
    priorProxyToken,
    agentApiKey,
    priorAgentApiKey,
  }: {
    issuedProxyToken: boolean;
    localContext?: string;
    proxyToken?: string;
    priorProxyToken?: string;
    agentApiKey?: string;
    priorAgentApiKey?: string;
  },
): Promise<void> | undefined {
  if (issuedProxyToken) {
    restoreSupersededProxyToken(ports.agentProxyTokens, agentId, proxyToken, priorProxyToken);
    if (localContext !== undefined) ports.revokeLocalLaunch(agentId, localContext, proxyToken);
  }
  if (agentApiKey) {
    restoreSupersededAgentApiKey(ports.agentApiKeys, agentId, agentApiKey, priorAgentApiKey);
    return revokeFailedLaunchKey(ports, agentId, agentApiKey);
  }
}

async function revokeFailedLaunchKey(
  ports: { revokeAgentApiKey(agentId: string, key: string): Promise<void> },
  agentId: string,
  agentApiKey: string,
): Promise<void> {
  try {
    await ports.revokeAgentApiKey(agentId, agentApiKey);
  } catch (revokeError) {
    logAgentApiKeyRevokeFailed(agentId, revokeError);
  }
}

type LaunchDisposables = {
  dispose(agentId: string): void;
};
type LaunchUsageReport = {
  forget(agentId: string): void;
  flushAllTokenUsage?(
    agentId: string,
    launch: PublishedActivityLaunch,
    provider: RuntimeProvider,
    fallbackModel?: string,
  ): number;
};

type DisposableLaunch = PublishedActivityLaunch & {
  model?: string;
  stalled?: LaunchDisposables;
};

export function disposeLaunchObservations(
  agentId: string,
  launches: Map<string, DisposableLaunch | undefined>,
  phaseBookkeeping: LaunchDisposables,
  usageReport: LaunchUsageReport,
  fastModeWarned: Set<string>,
): void {
  const launch = launches.get(agentId);
  launch?.stalled?.dispose(agentId);
  phaseBookkeeping.dispose(agentId);
  if (launch?.provider)
    usageReport.flushAllTokenUsage?.(agentId, launch, launch.provider, launch.model);
  usageReport.forget(agentId);
  fastModeWarned.delete(agentId);
}

type RunningAgents = {
  runningAgentIds(): string[];
  isStopping(agentId: string): boolean;
};
type StopState = { stopping(agentId: string): boolean };

/** The Agents a ready names as running: processes still up that are neither mid-launch nor
 * stopping — a stopping Agent is about to announce itself instead. */
export function readyRunningAgentIds(
  agents: RunningAgents,
  launches: Map<string, unknown>,
  stopState: StopState,
): string[] {
  return agents
    .runningAgentIds()
    .filter(
      (agentId) =>
        !launches.has(agentId) && !stopState.stopping(agentId) && !agents.isStopping(agentId),
    );
}
