import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";

/**
 * The worst a Daemon stop can take: the process-tree cleanup ladder's two waits (terminate, then
 * the escalation) plus the drain deadline that release gives it. `STALLED_RECOVERY_EXIT_TIMEOUT_MS`
 * spends the same budget on a stalled turn; a guard test keeps the two equal so neither drifts.
 */
export const DAEMON_STOP_WORST_CASE_MS = 2 * PROCESS_TREE_EXIT_GRACE_MS + 10_000;

/**
 * How long launchd may keep a Daemon job alive after it sends SIGTERM before SIGKILLing it: the
 * worst case plus ten seconds. The plist said 2 seconds until task #726, so launchd killed a
 * Daemon in the middle of the cleanup it was still finishing, and the job it left behind was half
 * torn down. Raft 1.0.65's `computer.cjs` writes no `ExitTimeOut` key at all (default 20 s), so
 * this is our own arithmetic rather than a value copied from it.
 */
export const LAUNCHD_EXIT_TIMEOUT_SECONDS = (DAEMON_STOP_WORST_CASE_MS + 10_000) / 1000;

/**
 * How long the supervisor waits for the job to leave launchd. Past launchd's own SIGKILL, so a
 * slow stop is never reported as a failed one while launchd is still finishing it; the
 * #34→#35 upgrade incident was exactly a caller that stopped waiting too early.
 */
export const DAEMON_STOP_WAIT_MS = LAUNCHD_EXIT_TIMEOUT_SECONDS * 1000 + 5_000;
