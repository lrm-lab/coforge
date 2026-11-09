import { expect, test } from "bun:test";
import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { STALLED_RECOVERY_EXIT_TIMEOUT_MS } from "#src/daemon-runtime/stalled-recovery";

/**
 * A stop asks the provider to exit, waits one grace, escalates to a forced kill, and waits a
 * second grace — so two rungs is the least time a cleanup can need (task #726 matched Raft's
 * ten-second grace, up from five).
 */
test("the stop grace is Raft's ten seconds", () => {
  expect(PROCESS_TREE_EXIT_GRACE_MS).toBe(10_000);
});

test("the release deadline a restart waits on outlasts both rungs of the cleanup ladder", () => {
  // Otherwise the deadline fires inside the ladder: the forced kill is never awaited, the
  // release reports "did not exit in time", and a restart over a stopped process begins while
  // its tree may still be alive.
  expect(STALLED_RECOVERY_EXIT_TIMEOUT_MS).toBeGreaterThan(2 * PROCESS_TREE_EXIT_GRACE_MS);
});
