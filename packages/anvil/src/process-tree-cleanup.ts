import type {
  OwnedChildProcess,
  OwnedProcessTree,
  OwnedProcessTreeKillReport,
} from "./process-tree";
import { AgentProcessCleanupError } from "./contract";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "process-tree-cleanup"]);

export type ProcessTreeCleanupOptions = Readonly<{
  cutoffAtMs?: number;
  onKillReport?: (report: OwnedProcessTreeKillReport) => void;
}>;

/** How long each rung of the cleanup ladder waits for the tree to exit. */
export const PROCESS_TREE_EXIT_GRACE_MS = 5_000;

/**
 * The one cleanup ladder a code-agent process runs over the tree it owns: ask politely, wait a
 * bounded moment, escalate to a forced terminate, wait again, and only then fail with
 * `AgentProcessCleanupError`; the child's stdin is closed afterwards so nothing can hold the tree
 * open. `JsonlProcess` and the per-turn `TurnProcess` both run it.
 *
 * What the caller waits on afterwards stays the caller's: a `TurnProcess` awaits its own `exited`
 * result, while `JsonlProcess` also waits for its adapter's diagnostics to drain.
 */
export async function cleanupOwnedTree(
  tree: OwnedProcessTree,
  child: OwnedChildProcess,
  options?: ProcessTreeCleanupOptions,
): Promise<void> {
  const turnScoped = options?.cutoffAtMs !== undefined && tree.terminateForTurn;
  // A restart that names no turn fence (none was known) keeps the whole-tree ladder: processes
  // started before the turn are killed too.
  if (options && !turnScoped)
    logger.warning("Turn-scoped cleanup unavailable; killing the whole process tree", {
      event: "process_tree_cleanup:whole_tree",
      reason: options.cutoffAtMs === undefined ? "no_turn_fence" : "no_turn_scoped_owner",
    });
  try {
    if (turnScoped) await tree.terminateForTurn!(false, options!.cutoffAtMs!);
    else await tree.terminate(false);
  } catch {
    // A bounded tree check below determines whether cleanup was successful.
  }
  let treeExited: boolean;
  try {
    treeExited = await tree.waitForExit(PROCESS_TREE_EXIT_GRACE_MS);
  } catch {
    throw new AgentProcessCleanupError();
  }
  if (!treeExited) {
    try {
      if (turnScoped) {
        const report = await tree.terminateForTurn!(true, options!.cutoffAtMs!);
        options?.onKillReport?.(report);
      } else await tree.terminate(true);
    } catch {
      // A bounded tree check below determines whether cleanup was successful.
    }
    try {
      treeExited = await tree.waitForExit(PROCESS_TREE_EXIT_GRACE_MS);
    } catch {
      throw new AgentProcessCleanupError();
    }
  }
  if (!treeExited) throw new AgentProcessCleanupError();
  try {
    child.stdin.end();
  } catch {
    // An exited child may have already closed stdin.
  }
}
