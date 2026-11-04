import type { AgentProxy } from "./runtime-launch-types";

/** Drops the Agent's issued local context and proxy token, only when the maps still hold exactly
 * the pair being revoked — a relaunched Agent's newer pair is never touched. */
export function revokeLocalLaunch(
  contexts: Map<string, string>,
  proxyTokens: Map<string, string>,
  proxy: AgentProxy | undefined,
  agentId: string,
  context?: string,
  proxyToken?: string,
): void {
  context ??= contexts.get(agentId);
  proxyToken ??= proxyTokens.get(agentId);
  if (context && contexts.get(agentId) === context) contexts.delete(agentId);
  if (proxyToken && proxyTokens.get(agentId) === proxyToken) proxyTokens.delete(agentId);
  if (proxyToken) proxy?.revoke(proxyToken);
}

type LaunchDisposables = {
  dispose(agentId: string): void;
};
type LaunchForget = { forget(agentId: string): void };

/** Drops every observation bookkeeping an ended launch left behind: its stall watchers, turn
 * phases, usage-window reading, and the one-time fast-mode hint, for exactly this Agent. */
export function disposeLaunchObservations(
  agentId: string,
  launches: Map<string, { stalled?: LaunchDisposables } | undefined>,
  phaseBookkeeping: LaunchDisposables,
  usageReport: LaunchForget,
  fastModeWarned: Set<string>,
): void {
  launches.get(agentId)?.stalled?.dispose(agentId);
  phaseBookkeeping.dispose(agentId);
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

type AgentSessions = { session(agentId: string): unknown };
type MentionIdentity = { launchId: string; sessionId: string };

/** The session+launch pair a running Agent may receive tracked mentions for — only while its
 * process is up and its reported session still matches the launch currently being observed. */
export function runningMentionIdentity(
  agentId: string,
  agents: AgentSessions,
  reportedSessions: Map<string, MentionIdentity>,
  currentLaunches: Map<string, { launchId?: string }>,
): MentionIdentity | undefined {
  if (!agents.session(agentId)) return undefined;
  const reported = reportedSessions.get(agentId);
  return reported && currentLaunches.get(agentId)?.launchId === reported.launchId
    ? reported
    : undefined;
}
