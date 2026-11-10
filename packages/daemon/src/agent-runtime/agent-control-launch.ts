import { getLogger } from "@logtape/logtape";
import type {
  AgentControlScope,
  AgentSessionInvalidateReason,
  AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import { AgentSessionRecoveryError } from "@lrm/coforge-anvil";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { settleLaunchFailure } from "./launch-attempt-failure";
import type { AgentRuntimeRecord } from "./agent-runtime-state";
import { assertPhaseInvariants } from "./agent-control-fence";
import type { AgentControlContext } from "./agent-control-runtime";
import { LaunchFailureBackoff } from "./launch-failure-backoff";
import type { LaunchRetryScheduler } from "./launch-retry-scheduler";
import { LaunchRetryTimers } from "./launch-retry-timers";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

/** The launch attempts of managed Starts, their automatic retries, and which Starts are pending. */
export class ManagedLaunches {
  /** Per-Agent launch-failure streaks and the cooldown each one owes: counted here rather than
   * derived from the control record, so a superseding Stop/Start cannot reset the limiter by
   * rewriting that record. */
  readonly #failures = new LaunchFailureBackoff();
  /** The one pending automatic launch retry per Agent, if any. */
  readonly #retries: LaunchRetryTimers;
  /** Start calls and launch retries currently running, per Agent. */
  readonly #startsRunning = new Map<string, number>();
  constructor(
    private readonly context: AgentControlContext,
    launchRetryScheduler: LaunchRetryScheduler,
  ) {
    this.#retries = new LaunchRetryTimers(launchRetryScheduler);
  }
  /**
   * Whether a Start is pending for this Agent: from the synchronous `start` call, through every
   * launch attempt and the cooldown before each automatic retry, until it launches or ends.
   */
  startPending(agentId: string): boolean {
    return (this.#startsRunning.get(agentId) ?? 0) > 0 || this.#retries.has(agentId);
  }

  /** Counts `run` as a pending Start of this Agent until it settles. */
  track(agentId: string, run: () => Promise<void>): Promise<void> {
    this.#beginStartRun(agentId);
    return run().finally(() => this.#endStartRun(agentId));
  }

  #beginStartRun(agentId: string): void {
    this.#startsRunning.set(agentId, (this.#startsRunning.get(agentId) ?? 0) + 1);
  }

  #endStartRun(agentId: string): void {
    const running = (this.#startsRunning.get(agentId) ?? 1) - 1;
    if (running > 0) this.#startsRunning.set(agentId, running);
    else this.#startsRunning.delete(agentId);
    this.#settleIfIdle(agentId);
  }

  #settleIfIdle(agentId: string): void {
    if (!this.startPending(agentId)) this.context.runtime.startSettled?.(agentId);
  }

  hasRetry(agentId: string): boolean {
    return this.#retries.has(agentId);
  }

  /** Drops the Agent's armed retry and its failure streak: the operation they belonged to ended. */
  supersede(agentId: string): void {
    this.#clearLaunchRetry(agentId);
    this.#failures.reset(agentId);
  }

  /**
   * One launch attempt for a managed Start, plus its retry bookkeeping: a failed spawn does not
   * end the operation with one `launch_failed` record any more — it counts, the next attempt
   * waits an exponentially growing capped cooldown, and the attempt is retried automatically
   * until it succeeds or the attempts run out.
   *
   * Extracted from `start()` so a retry can re-enter exactly this code under the same control
   * scope. That reuse is not an optimisation: the server only authorizes a daemon-side relaunch
   * while its operation is still `starting` under a matching requestId/epoch/launchId
   * (`agent-control.server.ts#authorizeLaunch` — "never for a superseded, failed, or stopped
   * operation"), so a retry can never be a fresh control operation the daemon invents; it must
   * stay inside the managed Start it is recovering.
   *
   * On failure the attempt either schedules the next one (the record stays `starting`, no result
   * is reported, and the server's operation stays pending) or reports the same terminal
   * `launch_failed` result this path always reported. The attempts are used up, or skipped
   * outright for a reason no retry can fix (`NON_RETRYABLE_LAUNCH_FAILURE_REASONS`, a login the
   * runtime no longer has), because the server's operation would otherwise stay pending for the
   * whole retry window. Call only inside the Agent's `state.run`: it writes the control record.
   */
  async attempt(
    intent: AgentStartIntent,
    scope: AgentControlScope,
    record: AgentRuntimeRecord,
    launchId: string,
    attempt: number,
  ): Promise<void> {
    record.scope = scope;
    record.action = "start";
    record.phase = "starting";
    record.launchId = launchId;
    record.daemonInstanceId = this.context.instanceId;
    this.context.sessions.beginLaunch(record);
    await this.context.state.store.write(intent.agentId, record);
    try {
      let identity;
      try {
        identity = await this.context.runtime.launch(intent, launchId);
      } catch (error) {
        if (!intent.sessionId || !(error instanceof AgentSessionRecoveryError)) throw error;
        const { sessionId: replaced, sessionMode: _, ...fresh } = intent;
        // Fire-and-forget: tell the server the stale session is gone BEFORE the fresh
        // launch attempt, so a later Restart never tries it again — even if this launch
        // then fails. Only the two invalidation reasons are reported; "session_in_use"
        // is a retry signal, not evidence the session itself is gone, so `reason` stays
        // undefined and neither `invalidateSession` nor the retry's narration fires.
        const reason: AgentSessionInvalidateReason | undefined =
          error.code === "session_missing"
            ? "missing"
            : error.code === "provider_replay_rejected"
              ? "provider_replay_rejected"
              : undefined;
        if (reason) this.context.runtime.invalidateSession?.(intent, launchId, replaced, reason);
        // The shared launch chooses the fresh session's first input: real recovery content
        // first, otherwise the neutral startup turn.
        identity = await this.context.runtime.launch(
          { ...fresh, sessionMode: "create" },
          launchId,
          replaced,
          reason,
        );
      }
      record.phase = "running";
      record.startResult = {
        ...scope,
        phase: "started",
        launchId,
        sequence: ++record.sequence,
        ...(identity ? { identity } : {}),
      };
      record.lastResult = record.startResult;
      this.context.sessions.capture(record, identity);
      await this.context.state.store.write(intent.agentId, record);
      assertPhaseInvariants(this.context, intent.agentId, record);
      this.#onLaunchSucceeded(intent.agentId);
    } catch (launchError) {
      await this.context.runtime.stop(intent.agentId);
      const failed = await settleLaunchFailure({
        intent,
        scope,
        launchId,
        attempt,
        record,
        error: launchError,
        failures: this.#failures,
        store: this.context.state.store,
        scheduleRetry: (next, cooldownMs, quotaProvider) =>
          this.#scheduleLaunchRetry(intent, scope, launchId, next, cooldownMs, quotaProvider),
        clearRetry: () => this.#clearLaunchRetry(intent.agentId),
      });
      if (failed) await this.context.runtime.result(failed).catch(() => {});
      return;
    }
    await this.context.runtime.result(record.lastResult).catch(() => {});
  }

  /** Clears the failure streak after a successful launch, narrating a recovery only when there
   * actually was a streak to recover from. */
  #onLaunchSucceeded(agentId: string): void {
    const attempts = this.#failures.reset(agentId);
    this.#clearLaunchRetry(agentId);
    if (attempts > 0)
      logger.info("Agent launch recovered after retrying", {
        event: "agent_control:launch_retry_recovered",
        agent_id: agentId,
        attempts,
      });
  }

  /**
   * Arms the single automatic retry for this Agent after `delayMs`. The callback re-reads the
   * control record under the same per-Agent mutex every other transition takes, so a Stop or a
   * newer Start that landed during the cooldown wins: the retry sees a phase/epoch/launchId it
   * does not own and simply returns.
   */
  #scheduleLaunchRetry(
    intent: AgentStartIntent,
    scope: AgentControlScope,
    launchId: string,
    attempt: number,
    delayMs: number,
    quotaProvider?: string,
  ): void {
    this.#clearLaunchRetry(intent.agentId);
    this.#retries.arm(
      intent.agentId,
      () => {
        this.#beginStartRun(intent.agentId);
        this.#retries.fired(intent.agentId);
        void this.context.state
          .run(intent.agentId, async () => {
            const record = await this.context.state.store.read(intent.agentId);
            if (
              !record ||
              record.phase !== "starting" ||
              record.scope.epoch !== scope.epoch ||
              record.launchId !== launchId
            )
              return;
            if (this.context.runtime.running(intent.agentId)) {
              // Something else brought the process up first (a rebind, or a wake through the
              // runtime); adopt that success instead of spawning a second process.
              this.#onLaunchSucceeded(intent.agentId);
              return;
            }
            await this.attempt(intent, scope, record, launchId, attempt);
          })
          .catch((error) => {
            logger.error("Agent launch retry could not run", {
              event: "agent_control:launch_retry_error",
              agent_id: intent.agentId,
              attempt,
              error_code: diagnosticErrorCode(error),
            });
          })
          .finally(() => this.#endStartRun(intent.agentId));
      },
      delayMs,
      quotaProvider,
    );
  }

  #clearLaunchRetry(agentId: string): void {
    if (this.#retries.cancel(agentId)) this.#settleIfIdle(agentId);
  }

  /** `provider`'s limit was lifted: its launches waiting on the quota reset retry now. */
  endQuotaLaunchWaits(provider: string): number {
    return this.#retries.endQuotaWaits(provider);
  }

  /** Drops every pending retry and every failure streak. Called on daemon shutdown: a pending
   * retry has no meaning for the next daemon instance, which re-derives its work from the
   * control records (a retry this one died mid-cooldown left behind a repairable "starting"
   * record). */
  dispose(): void {
    this.#retries.cancelAll();
    this.#failures.clear();
  }
}
