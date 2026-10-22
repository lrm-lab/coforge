import {
  AGENT_SERVICE_TIER_OBSERVED,
  type AgentServiceTierObserved,
} from "@lrm/coforge-sdk/internal";
import { asRecord, eventTime } from "#src/code-agent/json-record";

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
 * models to this map).
 */
export function claudeContextUsage(
  record: Readonly<Record<string, unknown>>,
  configuredModel: string | undefined,
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
  const usedTokens =
    nonNegativeNumber(lastMessage.input_tokens) +
    nonNegativeNumber(lastMessage.cache_read_input_tokens) +
    nonNegativeNumber(lastMessage.cache_creation_input_tokens);
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
  const windowTokens = nonNegativeNumber(selected.value.contextWindow);
  if (!windowTokens) return undefined;
  return { usedTokens, windowTokens, occurredAt: eventTime(record) };
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
