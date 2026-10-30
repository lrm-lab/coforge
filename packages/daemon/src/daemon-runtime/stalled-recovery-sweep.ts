import { getLogger } from "@logtape/logtape";
import { thrownMessage } from "@lrm/coforge-sdk/internal";
import type { ReleasableLaunch, StalledRuntime } from "#src/daemon-runtime/runtime-release";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** How often the daemon looks for stalled providers, as in the reference client (its sweep runs
 * every five minutes). A message's own arrival judges its Agent immediately; the sweep exists for
 * the deliveries that already wait quietly behind a provider that stopped answering. */
export const STALLED_RECOVERY_SWEEP_MS = 5 * 60_000;

export type StalledRecoverySweepPorts<L extends ReleasableLaunch> = Readonly<{
  agentIds(): string[];
  /** Deliveries waiting for the Agent: recovery exists for them; a silent launch with nothing
   * queued is left alone. */
  hasQueuedDeliveries(agentId: string): boolean;
  /** A runner hold pauses every Agent at once; no single one is judged while it stands. */
  runnerHold(): boolean;
  /** An Agent mid-stop is left to its stop, as an arriving message leaves it. */
  isStopping(agentId: string): boolean;
  /** A recovery in flight is not restarted by the next sweep. */
  isRecovering(agentId: string): boolean;
  /** The same stalled judgment a new message applies. */
  stalled(agentId: string): StalledRuntime<L> | undefined;
  /** Ends the stalled provider and wakes the Agent on the same launch, resuming its session. */
  recover(agentId: string, stalled: StalledRuntime<L>): Promise<void>;
}>;

/**
 * Every `STALLED_RECOVERY_SWEEP_MS`, judges each live Agent the way an arriving message does:
 * a busy turn silent past the stall window, with nothing it waits on still running and a session
 * the relaunch can resume, is restarted and its queued deliveries proceed.
 */
export class StalledRecoverySweep<L extends ReleasableLaunch> {
  readonly #ports: StalledRecoverySweepPorts<L>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(ports: StalledRecoverySweepPorts<L>) {
    this.#ports = ports;
  }

  /** Idempotent; the timer never keeps the process alive. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.sweep(), STALLED_RECOVERY_SWEEP_MS);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One sweep; a sweep still running is joined, not repeated. Never rejects. */
  sweep(): Promise<void> {
    this.#running ??= this.#sweep()
      .catch((error: unknown) =>
        logger.warn("Agent stalled recovery sweep failed", {
          event: "agent.runtime.stalled_recovery_sweep_failed",
          error: thrownMessage(error),
        }),
      )
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  async #sweep(): Promise<void> {
    let judged = 0;
    let recoveries = 0;
    for (const agentId of this.#ports.agentIds()) {
      if (
        this.#ports.runnerHold() ||
        this.#ports.isStopping(agentId) ||
        this.#ports.isRecovering(agentId)
      )
        continue;
      if (!this.#ports.hasQueuedDeliveries(agentId)) continue;
      const stalled = this.#ports.stalled(agentId);
      if (!stalled) continue;
      judged++;
      await this.#ports
        .recover(agentId, stalled)
        .then(() => {
          recoveries++;
        })
        .catch((error: unknown) =>
          logger.warn("Agent stalled recovery restart failed", {
            event: "agent.runtime.stalled_recovery_sweep_agent_failed",
            agent_id: agentId,
            error: thrownMessage(error),
          }),
        );
    }
    if (judged > 0)
      logger.info("Agent stalled recovery sweep", {
        event: "agent.runtime.stalled_recovery_sweep",
        agents_judged: judged,
        recoveries,
      });
  }
}
