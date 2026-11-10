import type { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import { isNonRetryableLaunchFailure } from "#src/agent-runtime/launch-failure";
import { recoveryWaitMs } from "#src/agent-runtime/runtime-error-classification";

/**
 * Consecutive failed wakes after which the Agent is no longer relaunched on its own, the reference
 * Computer's crash-streak cap. A failure no retry can fix ends the streak at once, as that
 * Computer's configuration failures do; a wait on a named quota reset is not a failed attempt.
 */
export const WAKE_FAILURE_STREAK_CAP = 5;

/**
 * Starts a message-triggered relaunch and records its failure on the wake cooldown.
 *
 * The cooldown is the short exponential backoff, unless the thrown text names a future quota
 * recovery time: then the next delivery does not launch until that time. The returned promise
 * still rejects. The failure is recorded on a detached chain so the caller observes the original
 * rejection, and the in-flight mark is cleared either way.
 */
export function beginWakeLaunch<T>(
  agentId: string,
  launch: Promise<T>,
  launches: Set<string>,
  failures: LaunchFailureBackoff,
): Promise<T> {
  launches.add(agentId);
  void launch
    .catch((error: unknown) => {
      const now = Date.now();
      failures.recordFailure(
        agentId,
        now,
        recoveryWaitMs(thrownText(error), now),
        isNonRetryableLaunchFailure(error),
      );
    })
    .finally(() => launches.delete(agentId));
  return launch;
}

function thrownText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}
