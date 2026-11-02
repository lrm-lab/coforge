import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** The stages every Agent launch passes, in order. `provider_session` covers the adapter's own
 * process spawn and ACP initialize as one step: persistent adapters do both inside
 * `createAgentSession`, so the daemon cannot observe them separately without a hook in every
 * provider host. */
export type LaunchPhase =
  | "admitted"
  | "config"
  | "provider_session"
  | "session_reported"
  | "first_activity";

/**
 * One launch's phase clock: an info line per phase with the total elapsed time and the time since
 * the previous phase, all sharing the launch id. A slow or hung launch then shows where the time
 * went without any Agent-level state; each phase logs once.
 */
export class LaunchPhaseTiming {
  readonly #startedAtMs = Date.now();
  #previousAtMs = this.#startedAtMs;
  readonly #logged = new Set<LaunchPhase>();

  constructor(
    private readonly facts: Readonly<{ agentId: string; launchId: string; provider: string }>,
  ) {}

  phase(phase: LaunchPhase): void {
    if (this.#logged.has(phase)) return;
    this.#logged.add(phase);
    const now = Date.now();
    logger.info("Agent launch phase", {
      event: "agent_launch:phase",
      agent_id: this.facts.agentId,
      launch_id: this.facts.launchId,
      provider: this.facts.provider,
      phase,
      elapsed_ms: now - this.#startedAtMs,
      since_previous_ms: now - this.#previousAtMs,
    });
    this.#previousAtMs = now;
  }
}
