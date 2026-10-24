import { useMemo } from "react";

import { pickBusyAgents, rankBusyAgents, type BusyAgent } from "./busy-agents";
import { useLiveWorkspaceAgents } from "./workspace-agents-realtime";

/**
 * The Agents of the Workspace, the viewer's own and every other the viewer may see, working or
 * thinking right now, most relevant first (`rankBusyAgents`). Repaints only when the set of busy
 * Agents or one of their displays changes.
 */
export function useWorkspaceBusyAgents(directAgentIds: ReadonlySet<string>): BusyAgent[] {
  const busy = useLiveWorkspaceAgents(pickBusyAgents);
  return useMemo(() => rankBusyAgents(busy, directAgentIds), [busy, directAgentIds]);
}
