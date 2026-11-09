import { expect, test } from "bun:test";
import { PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { STALLED_RECOVERY_EXIT_TIMEOUT_MS } from "#src/daemon-runtime/stalled-recovery";
import { jobPlist } from "#src/platform/launchd-job";
import {
  DAEMON_STOP_WAIT_MS,
  DAEMON_STOP_WORST_CASE_MS,
  LAUNCHD_EXIT_TIMEOUT_SECONDS,
} from "#src/platform/daemon-stop-wait";

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
  // And leaves room past the ladder for the drains that follow it — the provider's stderr pipe and
  // ACP disposal are awaited inside the same deadline.
  expect(STALLED_RECOVERY_EXIT_TIMEOUT_MS - 2 * PROCESS_TREE_EXIT_GRACE_MS).toBeGreaterThanOrEqual(
    10_000,
  );
});

/**
 * launchd says a job it stops has `ExitTimeOut` seconds to leave before SIGKILL, and the
 * supervisor stops waiting for it to leave at all after `DAEMON_STOP_WAIT_MS`. Both were far
 * shorter than a real stop: the plist said 2 seconds and the supervisor 15, so the daemon was
 * killed mid-cleanup and the stop was reported as failed while launchd was still finishing it.
 */
test("the job's exit timeout covers a stop's worst case plus a margin", () => {
  expect(DAEMON_STOP_WORST_CASE_MS).toBe(STALLED_RECOVERY_EXIT_TIMEOUT_MS);
  expect(LAUNCHD_EXIT_TIMEOUT_SECONDS * 1000 - DAEMON_STOP_WORST_CASE_MS).toBeGreaterThanOrEqual(
    10_000,
  );
  expect(jobPlist({ label: "l", directory: "/tmp", command: ["/bin/true"] })).toContain(
    `<key>ExitTimeOut</key><integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>`,
  );
});

test("the supervisor outlasts launchd's own kill, so a slow stop is not called a failure", () => {
  expect(DAEMON_STOP_WAIT_MS).toBeGreaterThan(LAUNCHD_EXIT_TIMEOUT_SECONDS * 1000);
});
