import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";
import { AgentTransportError } from "../connection/agent-transport-error";
import { loggedErrorMessage } from "./agent-failure-logs";

const logger = getLogger(["coforge", "daemon", "runtime"]);

export type IdleNudgeRequest = {
  freshSession?: boolean;
  backgroundTasks?: number;
  rulesShown?: boolean;
};

export type IdleNudgeResponse = {
  send: boolean;
  reason?: string;
  rules?: boolean;
  text?: string;
};

export type TaskIdleNudgePorts = {
  ask(agentId: string, request: IdleNudgeRequest): Promise<IdleNudgeResponse | undefined>;
  idle(agentId: string): boolean;
  backgroundTasks(agentId: string): number;
  reapBackgroundTasks?(agentId: string): Promise<void>;
  sessionId(agentId: string): string | undefined;
  freshSession(agentId: string): boolean;
  contextGeneration?(agentId: string): number | undefined;
  beforeIdleAsk?(agentId: string): boolean;
  deliver(agentId: string, text: string): Promise<boolean>;
  timeoutMs?: number;
  now?: () => number;
};

export const IDLE_NUDGE_TIMEOUT_MS = 15_000;
export const IDLE_NUDGE_UNSUPPORTED_RETRY_MS = 60 * 60_000;
export const IDLE_NUDGE_SKIPPED_LOG_INTERVAL_MS = 10 * 60_000;

type SessionContextState = {
  sessionId: string;
  generation: number | undefined;
  freshAsked: boolean;
  rulesShown: boolean;
};

export class TaskIdleNudge {
  readonly #inFlight = new Set<string>();
  readonly #sessionContexts = new Map<string, SessionContextState>();
  readonly #skippedLoggedAt = new Map<string, number>();
  #unsupportedUntil = 0;

  constructor(private readonly ports: TaskIdleNudgePorts) {}

  noteSessionContext(agentId: string, sessionId: string | undefined, generation?: number): void {
    if (sessionId === undefined) {
      this.#sessionContexts.delete(agentId);
      return;
    }
    const prior = this.#sessionContexts.get(agentId);
    if (prior?.sessionId === sessionId) return;
    this.#sessionContexts.set(agentId, {
      sessionId,
      generation,
      freshAsked: false,
      rulesShown: false,
    });
  }

  maybeAsk(agentId: string): void {
    if (!this.ports.idle(agentId)) return this.#skipped(agentId, "not_idle");
    if (this.ports.beforeIdleAsk?.(agentId) === true) return this.#skipped(agentId, "compacting");
    if (this.#inFlight.has(agentId)) return this.#skipped(agentId, "in_flight");
    if (this.#now() < this.#unsupportedUntil) return this.#skipped(agentId, "unsupported");
    const sessionId = this.ports.sessionId(agentId);
    const generation = this.ports.contextGeneration?.(agentId);
    const prior = this.#sessionContexts.get(agentId);
    const sameSession = sessionId !== undefined && prior?.sessionId === sessionId;
    const contextFresh =
      sameSession &&
      prior.generation !== undefined &&
      generation !== undefined &&
      generation > prior.generation;
    const sessionFresh =
      sessionId !== undefined &&
      this.ports.freshSession(agentId) &&
      (!sameSession || !prior.freshAsked);
    const fresh = sessionFresh || contextFresh;
    const rulesShown = sameSession && !contextFresh && prior.rulesShown;
    const nextGeneration = generation ?? (sameSession ? prior.generation : undefined);
    if (sessionId !== undefined) {
      this.#sessionContexts.set(agentId, {
        sessionId,
        generation: nextGeneration,
        freshAsked: (sameSession ? prior.freshAsked : false) || sessionFresh,
        rulesShown,
      });
    }
    const backgroundTasks = this.ports.backgroundTasks(agentId);
    this.#inFlight.add(agentId);
    void this.#askWithReap(
      agentId,
      fresh,
      backgroundTasks,
      rulesShown,
      sessionId,
      nextGeneration,
    ).finally(() => this.#inFlight.delete(agentId));
  }

  async #askWithReap(
    agentId: string,
    fresh: boolean,
    initialTasks: number,
    rulesShown: boolean,
    sessionId: string | undefined,
    generation: number | undefined,
  ): Promise<void> {
    let backgroundTasks = initialTasks;
    if (backgroundTasks > 0 && this.ports.reapBackgroundTasks) {
      await this.ports.reapBackgroundTasks(agentId).catch(() => {});
      backgroundTasks = this.ports.backgroundTasks(agentId);
    }
    await this.#ask(
      agentId,
      {
        ...(fresh ? { freshSession: true } : {}),
        ...(backgroundTasks > 0 ? { backgroundTasks } : {}),
        ...(rulesShown ? { rulesShown: true } : {}),
      },
      sessionId,
      generation,
    );
  }

  #now(): number {
    return this.ports.now?.() ?? Date.now();
  }

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

  async #ask(
    agentId: string,
    request: IdleNudgeRequest,
    sessionId: string | undefined,
    generation: number | undefined,
  ): Promise<void> {
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
        if (answer.rules === true && sessionId !== undefined) {
          const current = this.#sessionContexts.get(agentId);
          if (current?.sessionId === sessionId && current.generation === generation) {
            current.rulesShown = true;
          }
        }
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
