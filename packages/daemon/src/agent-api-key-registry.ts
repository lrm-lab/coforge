import type { DaemonRuntime } from "#src/daemon-runtime/runtime";

/** Binds the runtime's Agent API key registry to the local proxy's per-request {get,set} port.
 * Resolves lazily so a lookup before the runtime exists surfaces the runtime's own error. */
export function agentApiKeyRegistry(runtime: () => DaemonRuntime) {
  return {
    get: (agentId: string) => runtime().agentApiKeys.get(agentId),
    set: (agentId: string, agentApiKey: string) => {
      runtime().agentApiKeys.set(agentId, agentApiKey);
    },
  };
}
