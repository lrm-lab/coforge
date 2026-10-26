import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";

/** The existing injected Codex catalog wait, allowing the fixture's cold start. */
export const SHORT_CATALOG_DISCOVERY_TIMEOUT_MS = 1_500;

/** Two request waits followed by both owned-process cleanup rungs. */
export function spawnedCatalogDiscoveryBudgetMs(timeoutMs: number) {
  return 2 * timeoutMs + 2 * PROCESS_TREE_EXIT_GRACE_MS;
}
