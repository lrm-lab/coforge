import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "agent-control"]);

/** The fenced control operations whose latency `AgentControlOpTiming` measures (task #584). */
export type ControlOp = "stop" | "reset-workspace" | "start";

/**
 * One control operation's phase clock: an info line per phase with the total elapsed time and
 * the time since the previous phase, all sharing the request id, so the server's
 * `agent_control:request_*` logs and this daemon's `agent_launch:phase` lines bracket the same
 * operation. Each named phase logs once, in the order the operation passes it; `result_sent`
 * logs on every send, since a retried send is a new measurement of the same leg.
 */
export class ControlOpTiming {
  readonly #startedAtMs = Date.now();
  #previousAtMs = this.#startedAtMs;
  readonly #logged = new Set<string>();

  constructor(
    private readonly facts: Readonly<{
      agentId: string;
      requestId: string;
      op: ControlOp;
      daemonInstanceId: string;
    }>,
  ) {}

  get requestId(): string {
    return this.facts.requestId;
  }

  phase(phase: string): void {
    if (this.#logged.has(phase)) return;
    this.#logged.add(phase);
    this.#emit(phase);
  }

  /** Every control-result send is timed, repeats included. */
  resultSent(resultPhase: string): void {
    this.#emit("result_sent", resultPhase);
  }

  #emit(phase: string, resultPhase?: string): void {
    const now = Date.now();
    logger.info("Agent control phase", {
      event: "agent_control:phase",
      agent_id: this.facts.agentId,
      request_id: this.facts.requestId,
      op: this.facts.op,
      phase,
      ...(resultPhase !== undefined ? { result_phase: resultPhase } : {}),
      elapsed_ms: now - this.#startedAtMs,
      since_previous_ms: now - this.#previousAtMs,
      daemon_instance_id: this.facts.daemonInstanceId,
    });
    this.#previousAtMs = now;
  }
}

/**
 * The per-Agent operation clocks of one Workspace runtime: a fenced control operation begins
 * when `AgentControl`'s entry is called and ends when its `AgentControlResult` is sent, so the
 * pair brackets queueing inside the Agent's serialized state run as well as the work itself.
 * The clock lives in memory only — a result replayed after a restart finds no clock and is not
 * timed, and a newer request for the same Agent replaces the older clock.
 */
export class AgentControlOpTiming {
  readonly #ops = new Map<string, ControlOpTiming>();

  constructor(private readonly daemonInstanceId: string) {}

  /** Begins the operation's clock; a repeated call for the same request keeps it. */
  received(op: ControlOp, agentId: string, requestId: string): void {
    if (this.#ops.get(agentId)?.requestId === requestId) return;
    const timing = new ControlOpTiming({
      agentId,
      requestId,
      op,
      daemonInstanceId: this.daemonInstanceId,
    });
    this.#ops.set(agentId, timing);
    timing.phase("received");
  }

  /** Times a control-result send against the operation that produced it, when this runtime
   * still holds its clock. */
  resultSent(result: { agentId: string; requestId: string; phase: string }): void {
    const timing = this.#ops.get(result.agentId);
    if (timing?.requestId === result.requestId) timing.resultSent(result.phase);
  }
}
