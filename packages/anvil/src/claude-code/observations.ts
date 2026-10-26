import {
  AGENT_SERVICE_TIER_OBSERVED,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import { AGENT_RUNTIME_EVENT_TYPE, type AgentRuntimeEvent } from "#src/contract";
import { asRecord, eventTime, nonEmptyString } from "#src/json-record";

/**
 * The service tier a top-level `result` record reports for this launch, normalized to the SDK's
 * closed vocabulary, or `undefined` when this Claude Code build said nothing about it (which is
 * not the same as "off"). A value Claude reports that this adapter does not recognize becomes
 * `unreported` rather than being dropped, so a newer Claude cannot look like a silent one.
 */
export function claudeServiceTierState(
  record: Readonly<Record<string, unknown>>,
): AgentServiceTierObserved | undefined {
  const raw = typeof record.fast_mode_state === "string" ? record.fast_mode_state.trim() : "";
  if (!raw) return undefined;
  if (raw === "on") return AGENT_SERVICE_TIER_OBSERVED.ON;
  if (raw === "off") return AGENT_SERVICE_TIER_OBSERVED.OFF;
  if (raw === "cooldown") return AGENT_SERVICE_TIER_OBSERVED.COOLDOWN;
  return AGENT_SERVICE_TIER_OBSERVED.UNREPORTED;
}

/**
 * The context-window reading a top-level `result` record carries, or `undefined`
 * when this Claude Code build reports neither `usage.iterations` nor a matched
 * `modelUsage[...].contextWindow` — never guessed. `usedTokens` is the last `"message"`-typed
 * iteration's `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
 * `windowTokens` is the `modelUsage` entry whose key or `canonicalModel` matches
 * `configuredModel`, or, when unconfigured or unmatched, the entry with the largest
 * `inputTokens + cacheReadInputTokens + cacheCreationInputTokens` (a subagent turn adds extra
 * models to this map), capped at `autoCompactWindow` when given: Claude Code compacts there, so
 * the context can never fill the model's larger window.
 */
export function claudeContextUsage(
  record: Readonly<Record<string, unknown>>,
  configuredModel: string | undefined,
  autoCompactWindow?: number,
):
  | {
      usedTokens: number;
      windowTokens: number;
      occurredAt: string;
    }
  | undefined {
  const usage = asRecord(record.usage);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : undefined;
  if (!iterations?.length) return undefined;
  let lastMessage: Record<string, unknown> | undefined;
  for (const entry of iterations) {
    const parsed = asRecord(entry);
    if (parsed?.type === "message") lastMessage = parsed;
  }
  if (!lastMessage) return undefined;
  const usedTokens = claudeUsageContextTokens(lastMessage);
  const modelUsage = asRecord(record.modelUsage);
  if (!modelUsage) return undefined;
  const entries = Object.entries(modelUsage).flatMap(([model, raw]) => {
    const value = asRecord(raw);
    return value ? [{ model, value }] : [];
  });
  if (!entries.length) return undefined;
  const matched = configuredModel
    ? entries.find(
        ({ model, value }) => model === configuredModel || value.canonicalModel === configuredModel,
      )
    : undefined;
  const selected =
    matched ??
    entries.reduce((largest, candidate) =>
      claudeModelUsageWeight(candidate.value) > claudeModelUsageWeight(largest.value)
        ? candidate
        : largest,
    );
  const modelWindow = nonNegativeNumber(selected.value.contextWindow);
  if (!modelWindow) return undefined;
  const windowTokens = Math.min(modelWindow, autoCompactWindow ?? Infinity);
  return { usedTokens, windowTokens, occurredAt: eventTime(record) };
}

/** Input + cache read + cache creation tokens of a usage-shaped record: the context one request carried. */
export function claudeUsageContextTokens(usage: Readonly<Record<string, unknown>>): number {
  return (
    nonNegativeNumber(usage.input_tokens) +
    nonNegativeNumber(usage.cache_read_input_tokens) +
    nonNegativeNumber(usage.cache_creation_input_tokens)
  );
}

function claudeModelUsageWeight(value: Record<string, unknown>): number {
  return (
    nonNegativeNumber(value.inputTokens) +
    nonNegativeNumber(value.cacheReadInputTokens) +
    nonNegativeNumber(value.cacheCreationInputTokens)
  );
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Session-scoped observations preserve emission order and service-tier de-duplication. */
export class ClaudeSessionObservations {
  /** The last service tier reported for this session, so a repeated reading is not re-emitted. */
  #serviceTier: AgentServiceTierObserved | undefined;

  constructor(
    /** The Agent's configured model, if any: matched against `result.modelUsage`'s
     * keys/`canonicalModel` to select the context-window reading's window size. */
    private readonly configuredModel?: string,
    /** The child's auto-compact window; caps the window of context readings. */
    private readonly autoCompactWindow?: number,
  ) {}

  *read(record: Readonly<Record<string, unknown>>): Generator<AgentRuntimeEvent> {
    // A service-tier reading is a session fact observed at every top-level result, independent
    // of the turn's own running/interrupting/idle state below. Emitted only when it changes, so
    // a steady tier does not repeat every turn.
    const serviceTier = claudeServiceTierState(record);
    if (serviceTier !== undefined && serviceTier !== this.#serviceTier) {
      this.#serviceTier = serviceTier;
      // Claude's own explanation, when it gives one (`extra_usage_disabled`, ...), so a
      // launch that did not get Fast mode can say why rather than only that it did not.
      const reason = nonEmptyString(record.fast_mode_disabled_reason);
      yield {
        type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER,
        state: serviceTier,
        ...(reason ? { reason } : {}),
      };
    }
    // A context-window reading is a session fact observed at every top-level
    // result, independent of the turn's own running/interrupting/idle state below.
    const contextUsage = claudeContextUsage(record, this.configuredModel, this.autoCompactWindow);
    if (contextUsage)
      yield {
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: contextUsage.usedTokens,
        windowTokens: contextUsage.windowTokens,
        occurredAt: contextUsage.occurredAt,
      };
  }
}
