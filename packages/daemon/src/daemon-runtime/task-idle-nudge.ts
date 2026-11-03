import { getLogger } from "@logtape/logtape";

const logger = getLogger(["coforge", "daemon", "runtime"]);

/** What the daemon asks the cloud when an Agent has just gone idle. */
export type IdleNudgeRequest = {
  /** The Agent is in a session it did not resume, and has not been asked for this one. */
  freshSession?: boolean;
  /** How many background tasks this launch still runs; the cloud skips stale nudges then. */
  backgroundTasks?: number;
};

/** What the cloud answers: whether to remind, and the text to write as idle input. */
export type IdleNudgeResponse = {
  send: boolean;
  reason?: string;
  text?: string;
};

export type TaskIdleNudgePorts = {
  /** Asks the cloud; `undefined` is the route's 404, meaning this server has no idle nudge. */
  ask(agentId: string, request: IdleNudgeRequest): Promise<IdleNudgeResponse | undefined>;
  /** The Agent is online, not mid-turn, has nothing queued and is not backing off an error. */
  idle(agentId: string): boolean;
  /** Background tasks this Agent's launch still runs. */
  backgroundTasks(agentId: string): number;
  /** The native session the Agent is in now, if any. */
  sessionId(agentId: string): string | undefined;
  /** The current session is a new one, not a resume of an older session. */
  freshSession(agentId: string): boolean;
  /** Writes the reminder as idle input, the way a wake message is written. */
  deliver(agentId: string, text: string): Promise<boolean>;
  timeoutMs?: number;
};

export const IDLE_NUDGE_TIMEOUT_MS = 15_000;

/**
 * The daemon's side of the task idle reminder: when a turn ends and the Agent is genuinely idle,
 * ask the cloud once whether to remind it of its open Tasks, and write the answer as idle input.
 * One ask per Agent at a time; a server without the route (404) is never asked again until this
 * daemon restarts; a fresh session is asked once per session, because the cloud reminds all open
 * Tasks there.
 */
export class TaskIdleNudge {
  readonly #inFlight = new Set<string>();
  /** The session each Agent's fresh-session ask was made for. */
  readonly #askedSessions = new Map<string, string>();
  /** Set by the first 404: this server has no idle nudge until the daemon restarts. */
  #unsupported = false;

  constructor(private readonly ports: TaskIdleNudgePorts) {}

  /** Called where a turn ends or a process exits; never throws, never blocks that path. */
  maybeAsk(agentId: string): void {
    if (this.#unsupported || this.#inFlight.has(agentId) || !this.ports.idle(agentId)) return;
    const sessionId = this.ports.sessionId(agentId);
    const fresh =
      this.ports.freshSession(agentId) &&
      sessionId !== undefined &&
      this.#askedSessions.get(agentId) !== sessionId;
    if (fresh && sessionId !== undefined) this.#askedSessions.set(agentId, sessionId);
    const backgroundTasks = this.ports.backgroundTasks(agentId);
    this.#inFlight.add(agentId);
    void this.#ask(agentId, {
      ...(fresh ? { freshSession: true } : {}),
      ...(backgroundTasks > 0 ? { backgroundTasks } : {}),
    }).finally(() => this.#inFlight.delete(agentId));
  }

  async #ask(agentId: string, request: IdleNudgeRequest): Promise<void> {
    const timeoutMs = this.ports.timeoutMs ?? IDLE_NUDGE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let answer: IdleNudgeResponse | undefined;
    try {
      const raced = await Promise.race([
        this.ports.ask(agentId, request).then((response) => ({ response })),
        new Promise<{ timeout: true }>((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      // A server that never answers is not a server without the route: the next idle asks again.
      if ("timeout" in raced) return;
      answer = raced.response;
    } catch (error) {
      logger.info("Task idle nudge was not answered", {
        event: "task_idle_nudge:failed",
        agent_id: agentId,
        error_code: error instanceof Error ? error.name : "unknown",
      });
      return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (answer === undefined) {
      this.#unsupported = true;
      logger.info("This server has no task idle nudge; not asking again", {
        event: "task_idle_nudge:unsupported",
        agent_id: agentId,
      });
      return;
    }
    if (!answer.send || !answer.text) return;
    // The Agent may have picked up work while the answer was in flight: a reminder that would
    // interrupt a live turn is dropped rather than queued behind it.
    if (!this.ports.idle(agentId)) return;
    try {
      await this.ports.deliver(agentId, answer.text);
    } catch (error) {
      logger.info("Task idle reminder could not be written", {
        event: "task_idle_nudge:delivery_failed",
        agent_id: agentId,
        error_code: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
