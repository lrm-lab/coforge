import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { AgentTransportError } from "../connection/agent-transport-error";
import { loggedErrorMessage } from "./agent-failure-logs";

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
  /** Epoch milliseconds; injectable so the 404 retry window is testable. */
  now?: () => number;
};

export const IDLE_NUDGE_TIMEOUT_MS = 15_000;
/** A 404 pauses asking for this long, not until a restart: the web and the Computer ship
 * separately, so the route can appear while this daemon keeps running. */
export const IDLE_NUDGE_UNSUPPORTED_RETRY_MS = 60 * 60_000;

/** A declined nudge for the same Agent and reason logs at most this often: every idle transition
 * asks again, and a reason that keeps declining would otherwise write one line per turn end. */
export const IDLE_NUDGE_SKIPPED_LOG_INTERVAL_MS = 10 * 60_000;

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
  /** When each Agent-and-reason decline was last logged, for the skipped throttle. */
  readonly #skippedLoggedAt = new Map<string, number>();
  /** When a 404 last said this server has no idle nudge; asking resumes after the retry window. */
  #unsupportedUntil = 0;

  constructor(private readonly ports: TaskIdleNudgePorts) {}

  /** Called where a turn ends or a process exits; never throws, never blocks that path. */
  maybeAsk(agentId: string): void {
    if (this.#inFlight.has(agentId)) return this.#skipped(agentId, "in_flight");
    if (!this.ports.idle(agentId)) return this.#skipped(agentId, "not_idle");
    if (this.#now() < this.#unsupportedUntil) return this.#skipped(agentId, "unsupported");
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

  #now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** A gate that kept this Agent from being asked, logged at most once per interval per reason —
   * the same throttle a declined answer gets, so a busy Agent does not write a line per trigger. */
  #skipped(agentId: string, reason: string): void {
    const now = this.#now();
    const key = `${agentId} ${reason}`;
    const lastLogged = this.#skippedLoggedAt.get(key);
    if (lastLogged !== undefined && now - lastLogged < IDLE_NUDGE_SKIPPED_LOG_INTERVAL_MS) return;
    this.#skippedLoggedAt.set(key, now);
    logger.info("Task idle nudge was skipped before asking", {
      event: "task_idle_nudge:skipped",
      agent_id: agentId,
      reason,
    });
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
      if ("timeout" in raced) {
        logger.info("Task idle nudge was not answered in time", {
          event: "task_idle_nudge:timeout",
          agent_id: agentId,
          timeout_ms: timeoutMs,
        });
        return;
      }
      answer = raced.response;
    } catch (error) {
      logger.info("Task idle nudge was not answered", {
        event: "task_idle_nudge:failed",
        agent_id: agentId,
        ...idleNudgeErrorFields(error),
      });
      return;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (answer === undefined) {
      this.#unsupportedUntil = this.#now() + IDLE_NUDGE_UNSUPPORTED_RETRY_MS;
      logger.info("This server has no task idle nudge; asking again in an hour", {
        event: "task_idle_nudge:unsupported",
        agent_id: agentId,
        retry_after_ms: IDLE_NUDGE_UNSUPPORTED_RETRY_MS,
      });
      return;
    }
    if (!answer.send || !answer.text) {
      const reason = answer.reason ?? "";
      const key = `${agentId} ${reason}`;
      const now = this.#now();
      const lastLogged = this.#skippedLoggedAt.get(key);
      if (lastLogged === undefined || now - lastLogged >= IDLE_NUDGE_SKIPPED_LOG_INTERVAL_MS) {
        this.#skippedLoggedAt.set(key, now);
        logger.info("Task idle nudge was declined", {
          event: "task_idle_nudge:skipped",
          agent_id: agentId,
          ...(answer.reason ? { reason: answer.reason } : {}),
        });
      }
      return;
    }
    // The Agent may have picked up work while the answer was in flight: a reminder that would
    // interrupt a live turn is dropped rather than queued behind it.
    if (!this.ports.idle(agentId)) return;
    try {
      const delivered = await this.ports.deliver(agentId, answer.text);
      if (!delivered) {
        logger.info("Task idle reminder had no session to write to", {
          event: "task_idle_nudge:delivery_failed",
          agent_id: agentId,
          error_code: "no_session",
        });
      } else {
        logger.info("Task idle reminder was delivered", {
          event: "task_idle_nudge:delivered",
          agent_id: agentId,
        });
      }
    } catch (error) {
      logger.info("Task idle reminder could not be written", {
        event: "task_idle_nudge:delivery_failed",
        agent_id: agentId,
        ...idleNudgeErrorFields(error),
      });
    }
  }
}

/** The failure fields every idle-nudge log carries: a stable code, the scrubbed message (a bare
 * `Error` name told production nothing — task #639), and the transport shape when the cloud call
 * itself failed. */
function idleNudgeErrorFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    error_code: diagnosticErrorCode(error),
    error_message: loggedErrorMessage(error),
  };
  if (error instanceof AgentTransportError) {
    fields.failure_class = error.failureClass;
    fields.cause_code = error.causeCode;
    if (error.upstreamStatus !== undefined) fields.upstream_status = error.upstreamStatus;
    if (error.upstreamCode !== undefined) fields.upstream_code = error.upstreamCode;
  }
  return fields;
}
