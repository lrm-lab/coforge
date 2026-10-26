import {
  ANTIGRAVITY_MODELS_TIMEOUT_MS,
  ANTIGRAVITY_USAGE_TIMEOUT_MS,
  OPENCODE_PLAIN_MODELS_TIMEOUT_MS,
  OPENCODE_VERBOSE_MODELS_TIMEOUT_MS,
  PROCESS_TREE_EXIT_GRACE_MS,
  CATALOG_DISCOVERY_TIMEOUT_MS,
} from "@lrm/coforge-anvil";
import { PI_CATALOG_DISCOVERY_TIMEOUT_MS } from "#src/code-agent/pi/catalog";

/**
 * The longest a catalog discovery pass over spawned provider processes can run before the product
 * gives its own verdict: two bounded waits (the initialize reply, then the model list) and the two
 * rungs of the process cleanup ladder. An inventory pass runs the providers' discoveries
 * concurrently, so it ends with the slowest one.
 *
 * A test that really spawns the provider fixture needs at least this. With less, the runner ends a
 * slow but healthy run before the product's deadline can, and the abandoned test keeps running
 * into the tests after it.
 *
 * Pi's in-process discovery has no process to clean up; its own bound
 * (`PI_CATALOG_DISCOVERY_TIMEOUT_MS`) is part of the maximum, so the budget stays true if it grows.
 */
export const CATALOG_DISCOVERY_BUDGET_MS = Math.max(
  spawnedCatalogDiscoveryBudgetMs(CATALOG_DISCOVERY_TIMEOUT_MS),
  PI_CATALOG_DISCOVERY_TIMEOUT_MS,
);

/** Two bounded waits of `timeoutMs` each, then the two rungs of the process cleanup ladder. */
export function spawnedCatalogDiscoveryBudgetMs(timeoutMs: number) {
  return 2 * timeoutMs + 2 * PROCESS_TREE_EXIT_GRACE_MS;
}

/**
 * The catalog deadline a test injects when it waits one out, instead of production's. It still
 * leaves a freshly spawned fixture time to answer `initialize`, so the wait that times out is
 * `model/list`.
 */
export const SHORT_CATALOG_DISCOVERY_TIMEOUT_MS = 1_500;

/**
 * The longest one OpenCode catalog discovery over a spawned process can run before the product
 * gives its own verdict: the verbose run, then the plain retry, each with its own deadline. A test
 * that spawns the OpenCode fixture needs at least this, for the same reason as above.
 */
export const OPENCODE_DISCOVERY_BUDGET_MS =
  OPENCODE_VERBOSE_MODELS_TIMEOUT_MS + OPENCODE_PLAIN_MODELS_TIMEOUT_MS;

/**
 * The longest one Antigravity catalog discovery over a spawned process can run before the product
 * gives its own verdict: `agy models` fetches the list over the network, so it has its own deadline,
 * then the process cleanup ladder.
 */
export const ANTIGRAVITY_DISCOVERY_BUDGET_MS =
  ANTIGRAVITY_MODELS_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

/** The longest one `agy -p /usage` read can run before the product gives its own verdict: its own
 * deadline, then the process cleanup ladder. */
export const ANTIGRAVITY_USAGE_BUDGET_MS =
  ANTIGRAVITY_USAGE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;
