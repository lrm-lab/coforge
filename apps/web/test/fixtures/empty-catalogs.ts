/** A `CodeAgentDiscovery`'s no-catalog half: e2e runtimes stub real providers away, so every
 * discovery answers no catalogs and no failures. */
export const emptyCatalogs = {
  cachedCatalogs: async () => ({ catalogs: [], needsRefresh: false }),
  catalogs: async () => ({ catalogs: [], failures: [] }),
};
