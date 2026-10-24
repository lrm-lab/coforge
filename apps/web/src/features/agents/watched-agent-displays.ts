import { createContext, useContext, useEffect } from "react";

/** Registers interest in an Agent's display; the returned function releases it. */
export type DisplayWatcher = (agentId: string) => () => void;

/**
 * The Agents a mounted view reads the display of. The extras read answers a display only for the
 * busy Agents and the ones it is told to hold, so a view of an idle extra (a DM header, a thread's
 * following Agents) registers here and its Agent is held for as long as the view is mounted.
 * `onFirstWatch` runs when an Agent goes from unwatched to watched, so the provider can read it.
 */
export function createDisplayWatchRegistry(onFirstWatch: (agentId: string) => void) {
  const counts = new Map<string, number>();
  const watch: DisplayWatcher = (agentId) => {
    const count = counts.get(agentId) ?? 0;
    counts.set(agentId, count + 1);
    if (count === 0) onFirstWatch(agentId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (counts.get(agentId) ?? 1) - 1;
      if (left <= 0) counts.delete(agentId);
      else counts.set(agentId, left);
    };
  };
  return { watch, ids: (): string[] => [...counts.keys()] };
}

export const DisplayWatcherContext = createContext<DisplayWatcher | null>(null);

/** Holds `agentId`'s display for the life of the calling view (see `createDisplayWatchRegistry`);
 * a no-op outside `WorkspaceAgentsProvider`. */
export function useWatchAgentDisplay(agentId: string): void {
  const watch = useContext(DisplayWatcherContext);
  useEffect(() => watch?.(agentId), [watch, agentId]);
}
