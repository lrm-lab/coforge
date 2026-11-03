import type { LaunchFailureBackoff } from "#src/agent-runtime/launch-failure-backoff";
import { recoveryWaitMs } from "#src/agent-runtime/runtime-error-classification";

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
      failures.recordFailure(agentId, now, recoveryWaitMs(thrownText(error), now));
    })
    .finally(() => launches.delete(agentId));
  return launch;
}

function thrownText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "";
}
