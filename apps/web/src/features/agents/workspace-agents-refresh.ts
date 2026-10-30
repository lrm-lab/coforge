import type { ExtraAgent } from "./extra-agent";
import type { LiveAgent } from "./workspace-agents-realtime";

/** How `WorkspaceAgentsProvider` reads its Agents again: the extras' Query, the store entry an
 * extra becomes, what a refresh hands the status hook, and the debounce of directory changes. */

export const extraAgentsQueryKey = (workspaceId: string | undefined) =>
  ["extra-agents", workspaceId ?? null] as const;

/** An Agent beyond the viewer's roster as the store holds it: "inactive" until a live publication
 * says otherwise, matching `listAgents`'s own "nothing heard yet" default. */
export function extraLiveAgent(agent: ExtraAgent): LiveAgent {
  return { ...agent, status: { value: "inactive", expiresAt: null }, isExtra: true };
}

/** What a refresh hands `useAgentStatuses`: the roster and, when they were read, the extras. The
 * result is authoritative for the extras it carries, so one it dropped (an Agent the viewer lost
 * sight of, or that was deleted) leaves the store with it. */
export function refreshedAgents(
  roster: LiveAgent[],
  extras: readonly ExtraAgent[] | undefined,
): LiveAgent[] {
  return extras ? [...roster, ...extras.map(extraLiveAgent)] : roster;
}

type TimeoutScheduler = {
  set(callback: () => void, delayMs: number): number;
  clear(timer: number): void;
};

/** Coalesces a burst of Agent writes into one active-query invalidation. The scheduler is injected
 * so the debounce contract can be tested without mounting the app shell or a browser timer. */
export function createAgentDirectoryInvalidator(
  invalidate: () => void,
  scheduler: TimeoutScheduler = {
    set: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clear: (timer) => window.clearTimeout(timer),
  },
  delayMs = 500,
) {
  let timer: number | undefined;
  return {
    schedule() {
      if (timer !== undefined) scheduler.clear(timer);
      timer = scheduler.set(() => {
        timer = undefined;
        invalidate();
      }, delayMs);
    },
    cancel() {
      if (timer !== undefined) scheduler.clear(timer);
      timer = undefined;
    },
  };
}
