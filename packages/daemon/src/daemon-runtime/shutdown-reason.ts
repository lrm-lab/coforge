import {
  RUNNER_HOLD_REASONS,
  type DaemonShutdownReason,
  type RunnerHoldReason,
} from "@lrm/coforge-sdk/internal";

export const SHUTDOWN_HOLD_REASON_WINDOW_MS = 60_000;

export type RunnerHold = { reason: RunnerHoldReason; renewedAtMs: number };

export function shutdownReasonForHold(
  hold: RunnerHold | undefined,
  nowMs: number,
  installerJournalExists: () => boolean,
): DaemonShutdownReason {
  if (hold && nowMs - hold.renewedAtMs <= SHUTDOWN_HOLD_REASON_WINDOW_MS) {
    switch (hold.reason) {
      case RUNNER_HOLD_REASONS.WORKSPACE_RESTART:
      case RUNNER_HOLD_REASONS.COMPUTER_RESTART:
        return "computer_restart";
      case RUNNER_HOLD_REASONS.COMPUTER_UPGRADE:
        return "computer_upgrade";
    }
  }
  return installerJournalExists() ? "computer_upgrade" : "computer_stop";
}
