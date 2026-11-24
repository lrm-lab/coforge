import type { AgentTurnTokenUsage } from "#src/contract";
import { asRecord } from "#src/json-record";
import { buildPromptCacheUsage, type PromptCacheUsage } from "#src/prompt-cache-usage";

function count(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

type CodexTokenTotals = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
}>;

function parseCodexTotals(
  record: Readonly<Record<string, unknown>> | undefined,
): CodexTokenTotals | undefined {
  if (!record) return undefined;
  const inputTokens = count(record.inputTokens, 0);
  const outputTokens = count(record.outputTokens, 0);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const rawInput = Math.round(inputTokens ?? 0);
  const cachedInputTokens = Math.min(Math.round(count(record.cachedInputTokens, 0) ?? 0), rawInput);
  const cacheWriteInputTokens = Math.min(
    Math.round(count(record.cacheWriteInputTokens, 0) ?? 0),
    Math.max(0, rawInput - cachedInputTokens),
  );
  const reasoning = count(record.reasoningOutputTokens, 0);
  return {
    inputTokens: rawInput,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: Math.round(outputTokens ?? 0),
    ...(reasoning !== undefined ? { reasoningOutputTokens: Math.round(reasoning) } : {}),
  };
}

function toTurnUsage(
  totals: CodexTokenTotals,
  context?: { usedTokens: number; windowTokens: number },
  model?: string,
): AgentTurnTokenUsage | undefined {
  const uncachedInputTokens = Math.max(
    0,
    totals.inputTokens - totals.cachedInputTokens - totals.cacheWriteInputTokens,
  );
  if (
    uncachedInputTokens +
      totals.cachedInputTokens +
      totals.cacheWriteInputTokens +
      totals.outputTokens <=
    0
  )
    return undefined;
  return {
    uncachedInputTokens,
    cacheReadTokens: totals.cachedInputTokens,
    cacheWriteTokens: totals.cacheWriteInputTokens,
    outputTokens: totals.outputTokens,
    ...(totals.reasoningOutputTokens !== undefined
      ? { reasoningOutputTokens: totals.reasoningOutputTokens }
      : {}),
    ...(model ? { model } : {}),
    ...(context
      ? { contextUsedTokens: context.usedTokens, contextWindowTokens: context.windowTokens }
      : {}),
  };
}

export class CodexTokenUsageTracker {
  #prevTotal: CodexTokenTotals | undefined;

  accept(
    params: Readonly<Record<string, unknown>> | undefined,
    context?: { usedTokens: number; windowTokens: number },
    model?: string,
  ): AgentTurnTokenUsage | undefined {
    const usage = asRecord(params?.tokenUsage);
    const total = parseCodexTotals(asRecord(usage?.total));
    const last = parseCodexTotals(asRecord(usage?.last));
    if (!total) return last ? toTurnUsage(last, context, model) : undefined;
    const prev = this.#prevTotal;
    this.#prevTotal = total;
    if (!prev) return last ? toTurnUsage(last, context, model) : toTurnUsage(total, context, model);
    if (
      total.inputTokens === prev.inputTokens &&
      total.cachedInputTokens === prev.cachedInputTokens &&
      total.cacheWriteInputTokens === prev.cacheWriteInputTokens &&
      total.outputTokens === prev.outputTokens
    )
      return undefined;
    if (total.inputTokens < prev.inputTokens || total.outputTokens < prev.outputTokens)
      return last ? toTurnUsage(last, context, model) : toTurnUsage(total, context, model);
    const deltaInput = total.inputTokens - prev.inputTokens;
    const deltaCached = Math.min(
      Math.max(0, total.cachedInputTokens - prev.cachedInputTokens),
      deltaInput,
    );
    const deltaCacheWrite = Math.min(
      Math.max(0, total.cacheWriteInputTokens - prev.cacheWriteInputTokens),
      Math.max(0, deltaInput - deltaCached),
    );
    const deltaOutput = total.outputTokens - prev.outputTokens;
    const rawDeltaReasoning =
      total.reasoningOutputTokens !== undefined && prev.reasoningOutputTokens !== undefined
        ? Math.max(0, total.reasoningOutputTokens - prev.reasoningOutputTokens)
        : (last?.reasoningOutputTokens ?? total.reasoningOutputTokens);
    const deltaReasoning =
      rawDeltaReasoning !== undefined ? Math.min(rawDeltaReasoning, deltaOutput) : undefined;
    return toTurnUsage(
      {
        inputTokens: deltaInput,
        cachedInputTokens: deltaCached,
        cacheWriteInputTokens: deltaCacheWrite,
        outputTokens: deltaOutput,
        ...(deltaReasoning !== undefined ? { reasoningOutputTokens: deltaReasoning } : {}),
      },
      context,
      model,
    );
  }
}

export function codexContextUsage(
  params: Readonly<Record<string, unknown>> | undefined,
): { usedTokens: number; windowTokens: number } | undefined {
  const usage = asRecord(params?.tokenUsage);
  const usedTokens = count(asRecord(usage?.last)?.totalTokens, 0);
  const windowTokens = count(usage?.modelContextWindow, 1);
  if (usedTokens === undefined || windowTokens === undefined) return;
  return { usedTokens, windowTokens };
}

export function codexPromptCacheUsage(
  params: Readonly<Record<string, unknown>> | undefined,
): PromptCacheUsage | undefined {
  const last = asRecord(asRecord(params?.tokenUsage)?.last);
  if (!last) return undefined;
  return buildPromptCacheUsage({
    inputTokens: last.inputTokens,
    cachedInputTokens: last.cachedInputTokens,
    cacheWriteInputTokens: last.cacheWriteInputTokens,
    outputTokens: last.outputTokens,
    reasoningOutputTokens: last.reasoningOutputTokens,
  });
}
