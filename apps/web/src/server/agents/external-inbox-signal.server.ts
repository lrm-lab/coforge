import { cacheInvalidation } from "#src/server/cache-invalidation.server";

const CHANNEL = "coforge:external-agent-inbox:v1";

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let attached = false;

function attach() {
  if (attached) return;
  attached = true;
  cacheInvalidation(CHANNEL).forgetWith((agentId) => {
    const woken =
      agentId === undefined
        ? [...listeners.values()].flatMap((set) => [...set])
        : [...(listeners.get(agentId) ?? [])];
    for (const listener of woken) listener();
  });
}

export const externalInboxSignal = {
  subscribe(agentId: string, listener: Listener): () => void {
    attach();
    let set = listeners.get(agentId);
    if (!set) listeners.set(agentId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && listeners.get(agentId) === set) listeners.delete(agentId);
    };
  },

  notify(agentId: string): void {
    cacheInvalidation(CHANNEL).notify(agentId);
  },

  listenerCount(): number {
    return [...listeners.values()].reduce((sum, set) => sum + set.size, 0);
  },
};
