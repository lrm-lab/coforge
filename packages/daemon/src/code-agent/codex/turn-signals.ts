import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { asRecord, eventTime, nonEmptyString, type JsonRecord } from "#src/code-agent/json-record";
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
const SUMMARY_BOUND = 300;

/**
 * Thread health beyond turn content, after the reference Computer 1.0.51: a completed turn with no
 * evidence of work or a `systemError` status is an error; warnings and waiting are logged only.
 */
export class CodexTurnSignals {
  readonly #threadId: string;
  readonly #agentId: string | undefined;
  readonly #runtimeId: string | undefined;
  #evidence = false;
  #assistantText = false;
  #visibleText = false;

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
   * or is for another thread; otherwise the events it yields (none for a diagnostic).
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
    return [];
  }

  #status(record: JsonRecord, params: JsonRecord): AgentRuntimeEvent[] {
    const status = asRecord(params.status);
    if (status?.type === "systemError") {
      return [
        {
          type: "error",
          message:
            nonEmptyString(status.message) ??
            nonEmptyString(asRecord(status.error)?.message) ??
            nonEmptyString(params.message) ??
            nonEmptyString(asRecord(params.error)?.message) ??
            "Codex thread entered system error state",
          occurredAt: eventTime(record),
          providerErrorClass: "CodexThreadSystemError",
        },
      ];
    }
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
    return [];
  }
}
