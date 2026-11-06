import { useCallback, useMemo, useState } from "react";

export type StatusAgentRef = { id: string; computerId: string | null };

/**
 * The set of every live Agent's id in the Workspace (`statusAgentScopes`), whatever the viewer
 * may see: which Agents may report a status floor on the shared status channel. It follows the
 * same rule as the roster — the page's read, a refresh's newer one, and the page's again once it
 * reads anew — so an Agent created mid-session joins it on the next directory-event refresh
 * rather than waiting for a reload. A failed refresh keeps the last set.
 */
export function useStatusAgents(
  loaded: StatusAgentRef[] | undefined,
  workspaceId: string | undefined,
): {
  statusAgentIds: ReadonlySet<string>;
  keepStatusAgents: (readFor: string | undefined, read: StatusAgentRef[]) => void;
} {
  const [state, setState] = useState({ workspaceId, loaded, agents: loaded ?? [] });
  let current = state;
  if (state.workspaceId !== workspaceId || state.loaded !== loaded) {
    current = { workspaceId, loaded, agents: loaded ?? [] };
    setState(current);
  }
  const keepStatusAgents = useCallback(
    (readFor: string | undefined, read: StatusAgentRef[]) =>
      setState((held) => (held.workspaceId === readFor ? { ...held, agents: read } : held)),
    [],
  );
  const statusAgentIds = useMemo(
    () => new Set(current.agents.map((agent) => agent.id)),
    [current.agents],
  );
  return { statusAgentIds, keepStatusAgents };
}
