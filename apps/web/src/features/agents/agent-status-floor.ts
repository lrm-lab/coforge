import { createContext, useContext } from "react";
import { createStore, useSelector, type Store } from "@tanstack/react-store";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import type { AgentMascot } from "./agent-mascot";
import type { LiveAgent } from "./workspace-agents-realtime";
import { useWatchAgentDisplay } from "./watched-agent-displays";

export type StatusOnlyDisplays = ReadonlyMap<string, AgentDisplaySnapshot>;

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

export function useLiveAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  return useVisibleAgentDisplay(agentId);
}

export function selectHasLiveRosterAgent(
  agents: readonly { id: string; isExtra?: true }[],
  agentId: string | null | undefined,
): boolean {
  if (!agentId) return false;
  const agent = agentById(agents, agentId);
  return Boolean(agent && !agent.isExtra);
}

export function useHasLiveAgent(agentId: string | null | undefined): boolean {
  return useSelector(useContext(LiveAgentStoreContext), (agents) =>
    selectHasLiveRosterAgent(agents, agentId),
  );
}

export type LiveAgentIdentity = {
  displayName: string;
  avatarUrl?: string | null;
  mascot?: AgentMascot;
};

export function selectLiveAgentIdentity(
  agents: readonly Pick<LiveAgent, "id" | "displayName" | "avatarUrl" | "mascot">[],
  agentId: string,
): LiveAgentIdentity | undefined {
  const agent = agentById(agents, agentId);
  if (!agent) return undefined;
  return {
    displayName: agent.displayName,
    avatarUrl: agent.avatarUrl,
    mascot: agent.mascot,
  };
}

function sameAgentIdentity(
  a: LiveAgentIdentity | undefined,
  b: LiveAgentIdentity | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.displayName === b.displayName && a.avatarUrl === b.avatarUrl && a.mascot === b.mascot;
}

export function useLiveAgentIdentity(agentId: string): LiveAgentIdentity | undefined {
  return useSelector(
    useContext(LiveAgentStoreContext),
    (agents) => selectLiveAgentIdentity(agents, agentId),
    { compare: sameAgentIdentity },
  );
}

export function selectDisplayOnline(
  display: Pick<AgentDisplaySnapshot, "activityKind"> | undefined,
  stopped?: boolean,
): boolean | undefined {
  if (!display) return stopped === true ? false : undefined;
  return display.activityKind !== "offline";
}

export function useLiveAgentOnline(
  agentId: string,
  fallbackDisplay?: AgentDisplaySnapshot,
  stopped?: boolean,
): boolean | undefined {
  const liveStore = useContext(LiveAgentStoreContext);
  const floorStore = useContext(StatusOnlyDisplaysContext);
  const liveOnline = useSelector(liveStore, (agents) =>
    selectDisplayOnline(selectLiveAgentDisplay(agents, agentId)),
  );
  const floorOnline = useSelector(floorStore, (displays) =>
    selectDisplayOnline(agentId ? displays.get(agentId) : undefined),
  );
  return liveOnline ?? floorOnline ?? selectDisplayOnline(fallbackDisplay, stopped);
}

export type LiveAgentProfileMetrics = {
  contextUsage: AgentDisplaySnapshot["contextUsage"] | null;
  fastMode: AgentDisplaySnapshot["fastMode"] | null;
};

function sameContextUsage(
  a: AgentDisplaySnapshot["contextUsage"] | null | undefined,
  b: AgentDisplaySnapshot["contextUsage"] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.usedTokens === b.usedTokens &&
    a.windowTokens === b.windowTokens &&
    a.observedAtMs === b.observedAtMs
  );
}

function sameFastMode(
  a: AgentDisplaySnapshot["fastMode"] | null | undefined,
  b: AgentDisplaySnapshot["fastMode"] | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.requested === b.requested && a.observed === b.observed && a.observedAtMs === b.observedAtMs
  );
}

function sameProfileMetrics(a: LiveAgentProfileMetrics, b: LiveAgentProfileMetrics): boolean {
  return sameContextUsage(a.contextUsage, b.contextUsage) && sameFastMode(a.fastMode, b.fastMode);
}

export function selectDisplayProfileMetrics(
  display: AgentDisplaySnapshot | undefined,
): LiveAgentProfileMetrics {
  return {
    contextUsage: display?.contextUsage ?? null,
    fastMode: display?.fastMode ?? null,
  };
}

export function useLiveAgentProfileMetrics(
  agentId: string,
  fallbackDisplay?: AgentDisplaySnapshot,
): LiveAgentProfileMetrics {
  const liveStore = useContext(LiveAgentStoreContext);
  return useSelector(
    liveStore,
    (agents) =>
      selectDisplayProfileMetrics(selectLiveAgentDisplay(agents, agentId) ?? fallbackDisplay),
    { compare: sameProfileMetrics },
  );
}
