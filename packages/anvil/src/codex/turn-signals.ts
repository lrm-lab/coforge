import { AGENT_ACTIVITY_DETAIL_KIND, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { asRecord, eventTime, nonEmptyString, type JsonRecord } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { scrubError } from "./provider-support";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CODEX]);

const EMPTY_TURN_MESSAGE =
  "Codex runtime returned an empty response. Please retry. (codex_zero_evidence_turn_completed)";
const DIAGNOSTIC_METHODS = new Set([
  "configWarning",
  "warning",
  "guardianWarning",
  "deprecationNotice",
]);
const WAITING_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const SUMMARY_BOUND = 1_000;
const DIAGNOSTICS_SEEN_LIMIT = 64;
const DIAGNOSTIC_REPEAT_WINDOW_MS = 10 * 60 * 1_000;

/**
 * Thread health beyond turn content, after the reference Computer: a completed turn with no
 * evidence of work and a `systemError` status are errors; diagnostic and waiting warnings become
 * visible Activity entries.
 */
export class CodexTurnSignals {
  readonly #threadId: string;
  readonly #agentId: string | undefined;
  readonly #runtimeId: string | undefined;
  #evidence = false;
  #assistantText = false;
  #visibleText = false;
  #waitingSignature: string | undefined;
  #bareErrorWarned = false;
  #diagnosticsSeen = new Map<string, number>();

  constructor(threadId: string, agentId?: string, runtimeId?: string) {
    this.#threadId = threadId;
    this.#agentId = agentId;
    this.#runtimeId = runtimeId;
  }

  reset(): void {
    this.#evidence = false;
    this.#assistantText = false;
    this.#visibleText = false;
  }

  /** Any item or token-usage notification of the live turn shows it ran, whatever it produced. */
  markEvidence(): void {
    this.#evidence = true;
  }

  /** Only answer text matters here, to tell a blank final answer from none. */
  observe(event: AgentRuntimeEvent): void {
    if (event.type !== "text-delta" || this.#visibleText || !event.text) return;
    this.#assistantText = true;
    if (/\S/.test(event.text)) this.#visibleText = true;
  }

  /** The error to report before the `completed` event of a turn that ended with `status`. */
  finish(record: JsonRecord, status: string): AgentRuntimeEvent[] {
    const { agent_id, runtime_id } = { agent_id: this.#agentId, runtime_id: this.#runtimeId };
    const evidence = this.#evidence;
    const blank = this.#assistantText && !this.#visibleText;
    this.reset();
    if (status !== "completed") return [];
    if (evidence) {
      if (blank)
        logger.warn("Codex turn completed with a blank final answer", {
          event: "codex.turn.blank_final_answer",
          agent_id,
          runtime_id,
        });
      return [];
    }
    logger.warn("Codex turn completed without any output", {
      event: "codex.turn.empty",
      agent_id,
      runtime_id,
    });
    return [
      {
        type: "error",
        message: EMPTY_TURN_MESSAGE,
        occurredAt: eventTime(record),
        providerErrorClass: "CodexEmptyTurn",
        providerErrorReason: "empty_turn",
      },
    ];
  }

  /**
   * A thread status change or a diagnostic notification. `undefined` when the record is neither,
   * or is for another thread; otherwise the events it yields.
   */
  notification(
    record: JsonRecord,
    params: JsonRecord | undefined,
  ): AgentRuntimeEvent[] | undefined {
    const method = record.method;
    if (typeof method !== "string") return undefined;
    if (method === "thread/status/changed") {
      if (params?.threadId !== this.#threadId) return undefined;
      return this.#status(record, params);
    }
    if (!DIAGNOSTIC_METHODS.has(method)) return undefined;
    if (params?.threadId !== undefined && params.threadId !== this.#threadId) return undefined;
    const summary =
      nonEmptyString(params?.summary) ??
      nonEmptyString(params?.message) ??
      nonEmptyString(params?.details);
    logger.warn("Codex reported a diagnostic", {
      event: "codex.diagnostic",
      agent_id: this.#agentId,
      runtime_id: this.#runtimeId,
      kind: method,
      summary: summary === undefined ? undefined : scrubError(summary).slice(0, SUMMARY_BOUND),
    });
    const message = diagnosticMessage(method, params);
    const details = diagnosticDetails(method, params);
    const text = [message, ...(details && details !== message ? [details] : [])].join("\n");
    const signature = `${method}\n${text}`;
    const now = Date.parse(eventTime(record)) || Date.now();
    const seenAt = this.#diagnosticsSeen.get(signature);
    if (seenAt !== undefined && now - seenAt < DIAGNOSTIC_REPEAT_WINDOW_MS) return [];
    this.#diagnosticsSeen.delete(signature);
    if (this.#diagnosticsSeen.size >= DIAGNOSTICS_SEEN_LIMIT) {
      const oldest = this.#diagnosticsSeen.keys().next().value;
      if (oldest !== undefined) this.#diagnosticsSeen.delete(oldest);
    }
    this.#diagnosticsSeen.set(signature, now);
    return [warningActivity(diagnosticTitle(method), text, record)];
  }

  #status(record: JsonRecord, params: JsonRecord): AgentRuntimeEvent[] {
    const status = asRecord(params.status);
    if (status?.type === "systemError") {
      this.#waitingSignature = undefined;
      const message =
        nonEmptyString(status.message) ??
        nonEmptyString(asRecord(status.error)?.message) ??
        nonEmptyString(params.message) ??
        nonEmptyString(asRecord(params.error)?.message);
      const error: AgentRuntimeEvent = {
        type: "error",
        message: message ?? "Codex thread entered system error state",
        occurredAt: eventTime(record),
        providerErrorClass: "CodexThreadSystemError",
      };
      if (message) return [error];
      const events: AgentRuntimeEvent[] = [];
      if (!this.#bareErrorWarned) {
        this.#bareErrorWarned = true;
        events.push(
          warningActivity(
            "Codex warning",
            "Codex thread entered system error state without a reason",
            record,
          ),
        );
      }
      events.push(error);
      return events;
    }
    // Any status that is not systemError ends the current error episode, so the next bare
    // systemError warns again even when the thread only passed through a waiting state.
    this.#bareErrorWarned = false;
    const flags = Array.isArray(status?.activeFlags)
      ? status.activeFlags.filter((flag) => typeof flag === "string" && WAITING_FLAGS.has(flag))
      : [];
    if (status?.type === "active" && flags.length > 0)
      logger.warn("Codex thread is waiting on the user", {
        event: "codex.thread.waiting",
        agent_id: this.#agentId,
        runtime_id: this.#runtimeId,
        flags,
      });
    if (status?.type !== "active" || flags.length === 0) {
      this.#waitingSignature = undefined;
      return [];
    }
    const signature = [...flags].sort().join(",");
    if (signature === this.#waitingSignature) return [];
    this.#waitingSignature = signature;
    const waitingFor =
      flags.length > 1
        ? "approval and user input"
        : flags[0] === "waitingOnApproval"
          ? "approval"
          : "user input";
    return [
      warningActivity(
        "Codex warning",
        `Codex thread is waiting on ${waitingFor}\nActive flags: ${flags.join(", ")}`,
        record,
      ),
    ];
  }
}

function warningActivity(title: string, text: string, record: JsonRecord): AgentRuntimeEvent {
  return {
    type: "activity",
    activity: {
      detailKind: AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
      level: "warning",
      detail: "",
      observedAtMs: Date.parse(eventTime(record)) || Date.now(),
      entries: [{ kind: "system", title, text }],
    },
  };
}

function diagnosticTitle(method: string): string {
  switch (method) {
    case "configWarning":
      return "Codex config warning";
    case "guardianWarning":
      return "Codex guardian warning";
    case "deprecationNotice":
      return "Codex deprecation notice";
    default:
      return "Codex warning";
  }
}

function diagnosticMessage(method: string, params: JsonRecord | undefined): string {
  const value =
    method === "configWarning"
      ? (nonEmptyString(params?.summary) ?? nonEmptyString(params?.details))
      : method === "warning"
        ? nonEmptyString(params?.message)
        : method === "guardianWarning"
          ? nonEmptyString(params?.message)
          : method === "deprecationNotice"
            ? (nonEmptyString(params?.summary) ?? nonEmptyString(params?.details))
            : undefined;
  const fallback =
    method === "configWarning"
      ? "Codex configuration warning"
      : method === "guardianWarning"
        ? "Codex guardian warning"
        : method === "deprecationNotice"
          ? "Codex deprecation notice"
          : "Codex warning";
  return scrubError(value ?? fallback).slice(0, SUMMARY_BOUND);
}

function diagnosticDetails(method: string, params: JsonRecord | undefined): string | undefined {
  if (method !== "configWarning" && method !== "deprecationNotice") return undefined;
  const details = nonEmptyString(params?.details);
  return details ? scrubError(details).slice(0, SUMMARY_BOUND) : undefined;
}
