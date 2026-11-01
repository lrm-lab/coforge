import { getLogger } from "@logtape/logtape";
import {
  diagnosticErrorCode,
  type AgentControlResult,
  type AgentControlScope,
  type AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import { isNonRetryableLaunchFailure, launchFailureLogFields } from "./launch-failure";
import type { AgentRuntimeRecord, AgentRuntimeStateStore } from "./agent-runtime-state";
import { LAUNCH_FAILURE_MAX_ATTEMPTS, type LaunchFailureBackoff } from "./launch-failure-backoff";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

export type LaunchAttemptFailurePorts = {
  intent: AgentStartIntent;
  scope: AgentControlScope;
  launchId: string;
  /** The attempt that just failed, counting from 1. */
  attempt: number;
  record: AgentRuntimeRecord;
  error: unknown;
  failures: LaunchFailureBackoff;
  store: Pick<AgentRuntimeStateStore, "write">;
  scheduleRetry(attempt: number, cooldownMs: number): void;
  clearRetry(): void;
};

/**
 * What a failed launch attempt owes: one more attempt after its cooldown, or the terminal
 * `launch_failed` result. Returns the result the caller must report now, or undefined when a retry
 * was scheduled and the record stays live.
 *
 * A reason no retry can fix (`NON_RETRYABLE_LAUNCH_FAILURE_REASONS`, a login the runtime no longer
 * has) goes straight to the terminal record, so the server's Start operation is answered instead
 * of staying pending for the whole retry window.
 */
export async function settleLaunchFailure(
  ports: LaunchAttemptFailurePorts,
): Promise<AgentControlResult | undefined> {
  const { intent, record, error } = ports;
  const failure = ports.failures.recordFailure(intent.agentId);
  if (!isNonRetryableLaunchFailure(error) && ports.attempt < LAUNCH_FAILURE_MAX_ATTEMPTS) {
    logger.warning("Agent launch failed; retrying after backoff", {
      event: "agent_control:launch_retry_scheduled",
      agent_id: intent.agentId,
      attempt: ports.attempt,
      attempts: failure.attempts,
      cooldown_ms: failure.cooldownMs,
      retry_at_ms: failure.untilMs,
      outcome: "retry",
      error_code: diagnosticErrorCode(error),
      ...launchFailureLogFields(error),
    });
    // The record deliberately stays "starting": a live phase, so the next daemon instance
    // repairs a launch that died mid-cooldown instead of fencing on it (`repairStaleRecord`),
    // and the server's operation stays non-terminal so the retry is still authorized.
    // `lastResult` is left as it was — the retry owns the outcome now.
    await ports.store.write(intent.agentId, record);
    ports.scheduleRetry(ports.attempt + 1, failure.cooldownMs);
    return undefined;
  }
  const attempts = ports.failures.reset(intent.agentId);
  ports.clearRetry();
  record.phase = "failed";
  record.lastResult = {
    ...ports.scope,
    phase: "failed",
    launchId: ports.launchId,
    sequence: ++record.sequence,
    errorCode: "launch_failed",
  };
  logger.warning("Agent launch failed", {
    event: "agent_control:launch_failed",
    agent_id: intent.agentId,
    attempts,
    error_code: diagnosticErrorCode(error),
    // The terminal record of an exhausted launch carries the same classified evidence as the
    // retry warnings above: once the retries are gone this is the only log line left, so the
    // category/provider/model facts must not be stranded on the earlier `launch_retry_scheduled`.
    ...launchFailureLogFields(error),
  });
  await ports.store.write(intent.agentId, record);
  return record.lastResult;
}
