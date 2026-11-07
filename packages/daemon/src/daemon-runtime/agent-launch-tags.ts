import { sweepAgentLaunchTags } from "#src/platform/agent-launch-tag-sweep";

/** The per-process-launch tag token each running Agent launch carries in
 * `COFORGE_AGENT_LAUNCH_TAG` (task #673). The launch path registers its token so sweeps can
 * spare the live launch while collecting every earlier token's strays; a token is cleared
 * when its launch's process exits, so a stale exit event can never spare a newer launch's
 * strays. */
const launchTokens = new Map<string, string>();

/** Collects every stray process carrying this Agent's launch tags, sparing whichever token the
 * registry currently names — a launch that registered while the scan ran keeps its processes. */
export function sweepAgentLaunchTagStrays(agentId: string, trigger: string): void {
  void sweepAgentLaunchTags({
    agentId,
    spareToken: () => agentLaunchTagToken(agentId),
    trigger,
  });
}

/** Agents whose first launch since this Daemon process started already claimed its startup
 * sweep. Only that launch collects strays a previous Daemon's crash left behind; every later
 * launch — a wake, a cold-idle recycle, a restart — must leave the Agent's background
 * processes alone, so the claim is once per Agent per Daemon lifetime (task #673). */
const firstLaunchSweeps = new Set<string>();

/** Claims the one startup sweep an Agent gets per Daemon process lifetime; true only the first
 * time it is called for that Agent. */
export function claimAgentLaunchTagSweep(agentId: string): boolean {
  if (firstLaunchSweeps.has(agentId)) return false;
  firstLaunchSweeps.add(agentId);
  return true;
}

/** Agents whose process exit already scheduled an automatic relaunch (the resumed-session cold
 * start). An exit sweep must not collect strays the replacement launch keeps using; the mark
 * clears when that launch registers its token, so a later exit is judged on its own. */
const pendingRelaunches = new Set<string>();

export function noteAgentRelaunchPending(agentId: string): void {
  pendingRelaunches.add(agentId);
}

export function agentRelaunchPending(agentId: string): boolean {
  return pendingRelaunches.has(agentId);
}

export function setAgentLaunchTag(agentId: string, token: string): void {
  pendingRelaunches.delete(agentId);
  launchTokens.set(agentId, token);
}

/** The token of the Agent's current process launch, if one is registered. */
export function agentLaunchTagToken(agentId: string): string | undefined {
  return launchTokens.get(agentId);
}

/** Drops the registration when it still names `token`; a newer launch's token is left alone. */
export function clearAgentLaunchTag(agentId: string, token: string): void {
  if (launchTokens.get(agentId) === token) launchTokens.delete(agentId);
}
