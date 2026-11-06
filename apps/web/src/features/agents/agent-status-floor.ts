import { createContext, useContext, useMemo } from "react";
import { createStore, useSelector, type Store } from "@tanstack/react-store";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import type { LiveAgent } from "./workspace-agents-realtime";

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

/** One live Agent's display for an avatar's status dot, or nothing for an Agent not in the
 * viewer's roster (an `isExtra` Agent, which `useLiveAgents` leaves out too) or not live here. */
export function liveAgentDisplay(
  agents: readonly { id: string; display?: AgentDisplaySnapshot; isExtra?: true }[],
  agentId: string,
): AgentDisplaySnapshot | undefined {
  return agents.find((agent) => agent.id === agentId && !agent.isExtra)?.display;
}

/** One Agent's status floor — the reduced display a private Agent publishes on the shared
 * status channel — or nothing. A fallback only: a full display always wins over it. */
function useStatusOnlyAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  return useSelector(useContext(StatusOnlyDisplaysContext), (displays) => displays.get(agentId));
}

/** Each live Agent's latest display by id, for avatars' status dots. An Agent with no full
 * display falls back to its status floor, so a private Agent the viewer cannot otherwise see
 * still answers online/working/offline where its name already renders. */
export function useAgentDisplays(): Map<string, AgentDisplaySnapshot | undefined> {
  const agents = useSelector(useContext(LiveAgentStoreContext), (state) => state);
  const roster = useMemo(() => agents.filter((agent) => !agent.isExtra), [agents]);
  const statusOnly = useSelector(useContext(StatusOnlyDisplaysContext), (displays) => displays);
  return useMemo(() => {
    const displays = new Map(roster.map((agent) => [agent.id, agent.display]));
    for (const [agentId, display] of statusOnly)
      if (displays.get(agentId) === undefined) displays.set(agentId, display);
    return displays;
  }, [roster, statusOnly]);
}

/**
 * One visible Agent's display, another member's (`isExtra`) included, for the sidebar's DM face:
 * a DM with another member's public Agent is listed there too. An Agent with no full display
 * falls back to its status floor, so a private Agent the viewer cannot otherwise see still
 * answers where its name already renders. Repaints like `useLiveAgentDisplay`.
 */
export function useVisibleAgentDisplay(agentId: string): AgentDisplaySnapshot | undefined {
  const display = useSelector(
    useContext(LiveAgentStoreContext),
    (agents) => agents.find((agent) => agent.id === agentId)?.display,
  );
  const floor = useStatusOnlyAgentDisplay(agentId);
  return display ?? floor;
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
