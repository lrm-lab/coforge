import { createContext, useContext } from "react";
import { createStore, useSelector, type Store } from "@tanstack/react-store";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import type { LiveAgent } from "./workspace-agents-realtime";
import { useWatchAgentDisplay } from "./watched-agent-displays";

/**
 * The status floors (`statusOnly` snapshots) by Agent id. A floor is never a display: it answers
 * only "is this Agent online, working or offline" for an Agent the viewer cannot otherwise see,
 * so it lives beside the tracked Agents rather than in their `display` — a full snapshot, which
 * may share the floor's revision, always wins and a floor can never downgrade one.
 */
export type StatusOnlyDisplays = ReadonlyMap<string, AgentDisplaySnapshot>;

/** Applies a status floor, keeping the newest revision per Agent; the same map when nothing
 * changes, so readers do not repaint on a repeated or stale publication. */
export function mergeStatusOnlyDisplaySnapshot(
  current: StatusOnlyDisplays,
  snapshot: AgentDisplaySnapshot,
): StatusOnlyDisplays {
  const existing = current.get(snapshot.agentId);
  if (existing && existing.revision >= snapshot.revision) return current;
  const next = new Map(current);
  next.set(snapshot.agentId, snapshot);
  return next;
}

/** Drops an Agent's floor once its full display arrives (or it leaves the Workspace's status
 * set); the same map when there was none. */
export function dropStatusOnlyDisplay(
  current: StatusOnlyDisplays,
  agentId: string,
): StatusOnlyDisplays {
  if (!current.has(agentId)) return current;
  const next = new Map(current);
  next.delete(agentId);
  return next;
}

export const LiveAgentStoreContext = createContext<Store<LiveAgent[]>>(
  createStore<LiveAgent[]>([]),
);
// The status floors private Agents publish on the shared status channel, by Agent id: a status
// answer for an Agent the viewer cannot otherwise see, never a display and never directory data.
export const StatusOnlyDisplaysContext = createContext<Store<StatusOnlyDisplays>>(
  createStore<StatusOnlyDisplays>(new Map<string, AgentDisplaySnapshot>()),
);

const agentIndexCache = new WeakMap<
  readonly { id: string }[],
  ReadonlyMap<string, { id: string }>
>();

export function agentById<T extends { id: string }>(
  agents: readonly T[],
  agentId: string,
): T | undefined {
  if (!agentId) return undefined;
  let index = agentIndexCache.get(agents);
  if (!index) {
    const built = new Map<string, { id: string }>();
    for (const agent of agents) if (!built.has(agent.id)) built.set(agent.id, agent);
    agentIndexCache.set(agents, built);
    index = built;
  }
  return index.get(agentId) as T | undefined;
}

export function selectLiveAgentDisplay(
  agents: readonly { id: string; display?: AgentDisplaySnapshot }[],
  agentId: string,
): AgentDisplaySnapshot | undefined {
  return agentById(agents, agentId)?.display;
}

export function selectExtraWatchId(
  agents: readonly { id: string; isExtra?: true }[],
  agentId: string,
): string {
  return agentById(agents, agentId)?.isExtra ? agentId : "";
}

export function resolveAgentDisplay(
  liveDisplay: AgentDisplaySnapshot | undefined,
  floorDisplay: AgentDisplaySnapshot | undefined,
): AgentDisplaySnapshot | undefined {
  return liveDisplay ?? floorDisplay;
}

function useStatusOnlyAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  return useSelector(useContext(StatusOnlyDisplaysContext), (displays) =>
    agentId ? displays.get(agentId) : undefined,
  );
}

export function useVisibleAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  const liveStore = useContext(LiveAgentStoreContext);
  const watchExtraId = useSelector(liveStore, (agents) => selectExtraWatchId(agents, agentId));
  useWatchAgentDisplay(watchExtraId);
  const display = useSelector(liveStore, (agents) => selectLiveAgentDisplay(agents, agentId));
  const floor = useStatusOnlyAgentDisplay(agentId);
  return resolveAgentDisplay(display, floor);
}

/**
 * One Agent's display, for its avatar's status dot: repaints when that Agent's display changes
 * and not on another Agent's change or on a status lease refresh. Resolves by id across every
 * Agent the viewer may see — a full display first, the status floor for an Agent outside them —
 * so a private Agent's name surfaces (a channel member, a message sender) get its status too.
 */
export function useLiveAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  return useVisibleAgentDisplay(agentId);
}
