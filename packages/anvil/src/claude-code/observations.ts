import { getLogger } from "@logtape/logtape";
import {
  AGENT_SERVICE_TIER_OBSERVED,
  RUNTIME_PROVIDER,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import {
  AGENT_RUNTIME_EVENT_TYPE,
  type AgentRuntimeEvent,
  type AgentTurnTokenUsage,
} from "#src/contract";
import { asRecord, eventTime, nonEmptyString } from "#src/json-record";
import {
  buildPromptCacheUsage,
  promptCacheLogFields,
  type PromptCacheUsage,
} from "#src/prompt-cache-usage";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CLAUDE_CODE]);

export type ClaudeTokenCounts = Readonly<{
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}>;

const ZERO_COUNTS: ClaudeTokenCounts = {
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

function addCounts(a: ClaudeTokenCounts, b: ClaudeTokenCounts): ClaudeTokenCounts {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function parseModelUsageCounts(entry: Readonly<Record<string, unknown>>): ClaudeTokenCounts {
  return {
    uncachedInputTokens: Math.round(nonNegativeNumber(entry.inputTokens)),
    cacheReadTokens: Math.round(nonNegativeNumber(entry.cacheReadInputTokens)),
    cacheWriteTokens: Math.round(nonNegativeNumber(entry.cacheCreationInputTokens)),
    outputTokens: Math.round(nonNegativeNumber(entry.outputTokens)),
  };
}

export class ClaudeModelUsageTracker {
  readonly #byModel = new Map<string, { lastRaw: ClaudeTokenCounts; carried: ClaudeTokenCounts }>();

  fold(modelUsage: Readonly<Record<string, unknown>> | undefined): {
    delta: ClaudeTokenCounts;
    totals: ClaudeTokenCounts;
  } {
    let delta = ZERO_COUNTS;
    if (modelUsage) {
      for (const [model, raw] of Object.entries(modelUsage)) {
        const entry = asRecord(raw);
        if (!entry) continue;
        const current = parseModelUsageCounts(entry);
        const existing = this.#byModel.get(model);
        if (!existing) {
          this.#byModel.set(model, { lastRaw: current, carried: ZERO_COUNTS });
          delta = addCounts(delta, current);
          continue;
        }
        const reset =
          current.uncachedInputTokens < existing.lastRaw.uncachedInputTokens ||
          current.cacheReadTokens < existing.lastRaw.cacheReadTokens ||
          current.cacheWriteTokens < existing.lastRaw.cacheWriteTokens ||
          current.outputTokens < existing.lastRaw.outputTokens;
        if (reset) {
          const carried = addCounts(existing.carried, existing.lastRaw);
          this.#byModel.set(model, { lastRaw: current, carried });
          delta = addCounts(delta, current);
        } else {
          const step: ClaudeTokenCounts = {
            uncachedInputTokens: current.uncachedInputTokens - existing.lastRaw.uncachedInputTokens,
            cacheReadTokens: current.cacheReadTokens - existing.lastRaw.cacheReadTokens,
            cacheWriteTokens: current.cacheWriteTokens - existing.lastRaw.cacheWriteTokens,
            outputTokens: current.outputTokens - existing.lastRaw.outputTokens,
          };
          this.#byModel.set(model, { lastRaw: current, carried: existing.carried });
          delta = addCounts(delta, step);
        }
      }
    }
    let totals = ZERO_COUNTS;
    for (const state of this.#byModel.values()) {
      totals = addCounts(totals, addCounts(state.carried, state.lastRaw));
    }
    return { delta, totals };
  }
}

function lastClaudeMessageIteration(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const usage = asRecord(record.usage);
  const iterations = Array.isArray(usage?.iterations) ? usage.iterations : undefined;
  if (!iterations?.length) return undefined;
  let lastMessage: Record<string, unknown> | undefined;
  for (const entry of iterations) {
    const parsed = asRecord(entry);
    if (parsed?.type === "message") lastMessage = parsed;
  }
  return lastMessage;
}

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
  const lastMessage = lastClaudeMessageIteration(record);
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

export function claudeTurnTokenUsage(
  record: Readonly<Record<string, unknown>>,
  configuredModel?: string,
  contextUsage?: { usedTokens: number; windowTokens: number; occurredAt: string },
  modelTracker?: ClaudeModelUsageTracker,
): AgentTurnTokenUsage | undefined {
  const usage = asRecord(record.usage);
  const modelUsage = asRecord(record.modelUsage);
  if (!usage && !modelUsage) return undefined;
  const usageCounts: ClaudeTokenCounts = usage
    ? {
        uncachedInputTokens: Math.round(nonNegativeNumber(usage.input_tokens)),
        cacheReadTokens: Math.round(nonNegativeNumber(usage.cache_read_input_tokens)),
        cacheWriteTokens: Math.round(nonNegativeNumber(usage.cache_creation_input_tokens)),
        outputTokens: Math.round(nonNegativeNumber(usage.output_tokens)),
      }
    : ZERO_COUNTS;
  const modelDelta = modelUsage
    ? (modelTracker ?? new ClaudeModelUsageTracker()).fold(modelUsage).delta
    : ZERO_COUNTS;
  const uncachedInputTokens = Math.max(
    usageCounts.uncachedInputTokens,
    modelDelta.uncachedInputTokens,
  );
  const cacheReadTokens = Math.max(usageCounts.cacheReadTokens, modelDelta.cacheReadTokens);
  const cacheWriteTokens = Math.max(usageCounts.cacheWriteTokens, modelDelta.cacheWriteTokens);
  const outputTokens = Math.max(usageCounts.outputTokens, modelDelta.outputTokens);
  if (uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens <= 0)
    return undefined;
  let model = configuredModel;
  if (modelUsage) {
    const entries = Object.entries(modelUsage).flatMap(([name, raw]) => {
      const value = asRecord(raw);
      return value ? [{ name, value }] : [];
    });
    if (entries.length > 0) {
      const matched = configuredModel
        ? entries.find(
            ({ name, value }) =>
              name === configuredModel || value.canonicalModel === configuredModel,
          )
        : undefined;
      const selected =
        matched ??
        entries.reduce((largest, candidate) =>
          claudeModelUsageWeight(candidate.value) > claudeModelUsageWeight(largest.value)
            ? candidate
            : largest,
        );
      model = nonEmptyString(selected.value.canonicalModel) ?? selected.name;
    }
  }
  return {
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    ...(model ? { model } : {}),
    ...(contextUsage
      ? {
          contextUsedTokens: contextUsage.usedTokens,
          contextWindowTokens: contextUsage.windowTokens,
          occurredAt: contextUsage.occurredAt,
        }
      : { occurredAt: eventTime(record) }),
  };
}

export function claudePromptCacheUsage(
  record: Readonly<Record<string, unknown>>,
): PromptCacheUsage | undefined {
  const sample = lastClaudeMessageIteration(record) ?? asRecord(record.usage);
  if (!sample) return undefined;
  const cachedInputTokens = nonNegativeNumber(sample.cache_read_input_tokens);
  const cacheWriteInputTokens = nonNegativeNumber(sample.cache_creation_input_tokens);
  const inputTokens =
    nonNegativeNumber(sample.input_tokens) + cachedInputTokens + cacheWriteInputTokens;
  return buildPromptCacheUsage({
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: sample.output_tokens,
  });
}

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

export class ClaudeSessionObservations {
  #serviceTier: AgentServiceTierObserved | undefined;
  readonly #modelUsage = new ClaudeModelUsageTracker();

  constructor(
    private readonly configuredModel?: string,
    private readonly autoCompactWindow?: number,
  ) {}

  *read(
    record: Readonly<Record<string, unknown>>,
    sessionId?: string,
  ): Generator<AgentRuntimeEvent> {
    const serviceTier = claudeServiceTierState(record);
    if (serviceTier !== undefined && serviceTier !== this.#serviceTier) {
      this.#serviceTier = serviceTier;
      const reason = nonEmptyString(record.fast_mode_disabled_reason);
      yield {
        type: AGENT_RUNTIME_EVENT_TYPE.SERVICE_TIER,
        state: serviceTier,
        ...(reason ? { reason } : {}),
      };
    }
    const contextUsage = claudeContextUsage(record, this.configuredModel, this.autoCompactWindow);
    if (contextUsage)
      yield {
        type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE,
        usedTokens: contextUsage.usedTokens,
        windowTokens: contextUsage.windowTokens,
        occurredAt: contextUsage.occurredAt,
      };
    const turnTokenUsage = claudeTurnTokenUsage(
      record,
      this.configuredModel,
      contextUsage,
      this.#modelUsage,
    );
    if (turnTokenUsage)
      yield {
        type: AGENT_RUNTIME_EVENT_TYPE.TOKEN_USAGE,
        usage: turnTokenUsage,
      };
    const cacheUsage = claudePromptCacheUsage(record);
    if (cacheUsage) {
      logger.info("Claude Code observed prompt cache usage", {
        event: "claude_code.prompt_cache.usage",
        ...(sessionId ? { session_id: sessionId } : {}),
        ...promptCacheLogFields(cacheUsage),
      });
    }
  }
}
