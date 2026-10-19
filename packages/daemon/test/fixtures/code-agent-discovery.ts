import type { CodeAgentDiscovery } from "#src/daemon-runtime/code-agent-inventory-sync";

/** Discovers no Code Agent runtimes or catalogs, so a test's `DaemonRuntime` never probes the
 * provider CLIs installed on the machine running it. */
export const emptyCodeAgentDiscovery = {
  runtimes: async () => [],
  cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
  catalogs: async () => [],
} satisfies CodeAgentDiscovery;
