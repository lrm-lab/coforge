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
  requireCumulativeFields = false,
): CodexTokenTotals | undefined {
  if (!record) return undefined;
  const inputTokens = count(record.inputTokens, 0);
  const outputTokens = count(record.outputTokens, 0);
  const cached = count(record.cachedInputTokens, 0);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  if (
    requireCumulativeFields &&
    (inputTokens === undefined || outputTokens === undefined || cached === undefined)
  )
    return undefined;
  const rawInput = Math.round(inputTokens ?? 0);
  const cachedInputTokens = Math.min(Math.round(cached ?? 0), rawInput);
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

function sameUsage(left: CodexTokenTotals, right: CodexTokenTotals): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.outputTokens === right.outputTokens
  );
}

function regressedUsage(total: CodexTokenTotals, prev: CodexTokenTotals): boolean {
  return (
    total.inputTokens < prev.inputTokens ||
    total.outputTokens < prev.outputTokens ||
    total.cachedInputTokens < prev.cachedInputTokens ||
    total.cacheWriteInputTokens < prev.cacheWriteInputTokens
  );
}

const RESUMED_TURN_TOTALS_LIMIT = 64;

type UsageContext = { usedTokens: number; windowTokens: number };
type ResumedReading = "seen" | "awaiting-last" | AgentTurnTokenUsage;
type ResumedTurnUsage = {
  id: string;
  baseline: CodexTokenTotals | undefined;
  baselineTurnId: string | undefined;
  useCumulative: boolean;
  completed: boolean;
  last: CodexTokenTotals | undefined;
  readings: Map<string, ResumedReading>;
  earlierUsage: AgentTurnTokenUsage | undefined;
};

function combineUsage(
  earlier: AgentTurnTokenUsage | undefined,
  latest: AgentTurnTokenUsage,
): AgentTurnTokenUsage {
  if (!earlier) return latest;
  const reasoning =
    earlier.reasoningOutputTokens !== undefined || latest.reasoningOutputTokens !== undefined
      ? (earlier.reasoningOutputTokens ?? 0) + (latest.reasoningOutputTokens ?? 0)
      : undefined;
  return {
    ...earlier,
    ...latest,
    uncachedInputTokens: earlier.uncachedInputTokens + latest.uncachedInputTokens,
    cacheReadTokens: earlier.cacheReadTokens + latest.cacheReadTokens,
    cacheWriteTokens: earlier.cacheWriteTokens + latest.cacheWriteTokens,
    outputTokens: earlier.outputTokens + latest.outputTokens,
    ...(reasoning !== undefined ? { reasoningOutputTokens: reasoning } : {}),
  };
}

function cumulativeDelta(
  total: CodexTokenTotals,
  prev: CodexTokenTotals,
  reasoningFallback?: number,
): CodexTokenTotals {
  const inputTokens = total.inputTokens - prev.inputTokens;
  const cachedInputTokens = Math.min(
    Math.max(0, total.cachedInputTokens - prev.cachedInputTokens),
    inputTokens,
  );
  const cacheWriteInputTokens = Math.min(
    Math.max(0, total.cacheWriteInputTokens - prev.cacheWriteInputTokens),
    Math.max(0, inputTokens - cachedInputTokens),
  );
  const outputTokens = total.outputTokens - prev.outputTokens;
  const reasoning =
    total.reasoningOutputTokens !== undefined && prev.reasoningOutputTokens !== undefined
      ? Math.max(0, total.reasoningOutputTokens - prev.reasoningOutputTokens)
      : reasoningFallback;
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    ...(reasoning !== undefined
      ? { reasoningOutputTokens: Math.min(reasoning, outputTokens) }
      : {}),
  };
}

export class CodexTokenUsageTracker {
  #prevTotal: CodexTokenTotals | undefined;
  #prevTotalTurnId: string | undefined;
  #resumedTurn: ResumedTurnUsage | undefined;

  seedBaseline(params: Readonly<Record<string, unknown>> | undefined): void {
    if (typeof params?.turnId !== "string") return;
    const total = parseCodexTotals(asRecord(asRecord(params.tokenUsage)?.total), true);
    if (!total || (this.#prevTotal && regressedUsage(total, this.#prevTotal))) return;
    this.#prevTotal = total;
    this.#prevTotalTurnId = params.turnId;
  }

  noteLatePreviousTurn(
    activeTurnId: string | undefined,
    params: Readonly<Record<string, unknown>>,
  ): void {
    const turn = this.#resumedTurn?.id === activeTurnId ? this.#resumedTurn : undefined;
    const baseline = turn ? turn.baseline : this.#prevTotal;
    const baselineTurnId = turn ? turn.baselineTurnId : this.#prevTotalTurnId;
    if (!baseline || params.turnId !== baselineTurnId) return;
    const total = parseCodexTotals(asRecord(asRecord(params.tokenUsage)?.total), true);
    if (
      !total ||
      (total.inputTokens <= baseline.inputTokens &&
        total.outputTokens <= baseline.outputTokens &&
        total.cachedInputTokens <= baseline.cachedInputTokens &&
        total.cacheWriteInputTokens <= baseline.cacheWriteInputTokens)
    )
      return;

    if (activeTurnId !== undefined) this.#resumeTurn(activeTurnId).useCumulative = false;
    if (this.#prevTotal === baseline) {
      this.#prevTotal = undefined;
      this.#prevTotalTurnId = undefined;
    }
  }

  completeResumedTurn(turnId: string): AgentTurnTokenUsage[] {
    const turn = this.#resumeTurn(turnId);
    turn.completed = true;
    const accepted = turn.useCumulative && turn.earlierUsage ? [turn.earlierUsage] : [];
    turn.earlierUsage = undefined;
    for (const [key, reading] of turn.readings) {
      if (typeof reading === "string") continue;
      if (turn.useCumulative) accepted.push(reading);
      turn.readings.set(key, turn.useCumulative ? "seen" : "awaiting-last");
    }
    return accepted;
  }

  accept(
    params: Readonly<Record<string, unknown>> | undefined,
    context?: UsageContext,
    model?: string,
    resumedTurnId?: string,
  ): AgentTurnTokenUsage | undefined {
    const usage = asRecord(params?.tokenUsage);
    const total = parseCodexTotals(asRecord(usage?.total), resumedTurnId !== undefined);
    const last = parseCodexTotals(asRecord(usage?.last));
    const prev = this.#prevTotal;
    const reset =
      total &&
      prev &&
      (total.inputTokens < prev.inputTokens || total.outputTokens < prev.outputTokens);

    if (resumedTurnId !== undefined) {
      const turn = this.#resumeTurn(resumedTurnId);
      if (!total) {
        if (!last) return undefined;
        this.#prevTotal = undefined;
        this.#prevTotalTurnId = undefined;
        turn.useCumulative = false;
        const repeated = turn.last && sameUsage(last, turn.last);
        turn.last = last;
        return repeated ? undefined : toTurnUsage(last, context, model);
      }

      const key = `${total.inputTokens}/${total.cachedInputTokens}/${total.cacheWriteInputTokens}/${total.outputTokens}`;
      const existing = turn.readings.get(key);
      const unchanged = prev && sameUsage(total, prev);
      const regressed = prev && regressedUsage(total, prev);
      const crossTurnReset = regressed && this.#prevTotalTurnId !== resumedTurnId;
      if (existing !== undefined) {
        if (existing === "seen" || !last) return undefined;
        turn.readings.set(key, "seen");
        if (crossTurnReset) {
          this.#prevTotal = total;
          this.#prevTotalTurnId = resumedTurnId;
        }
        if (unchanged || crossTurnReset) turn.last = last;
        return toTurnUsage(last, context, model);
      }
      if (unchanged) return undefined;

      if (regressed && !crossTurnReset) return undefined;
      if (regressed || !prev) turn.useCumulative = false;

      if (turn.readings.size >= RESUMED_TURN_TOTALS_LIMIT) {
        const oldest = turn.readings.keys().next().value;
        if (oldest !== undefined) {
          const reading = turn.readings.get(oldest);
          if (typeof reading === "object")
            turn.earlierUsage = combineUsage(turn.earlierUsage, reading);
          turn.readings.delete(oldest);
        }
      }
      if (crossTurnReset && !last) {
        turn.readings.set(key, "awaiting-last");
        return undefined;
      }

      this.#prevTotal = total;
      this.#prevTotalTurnId = resumedTurnId;
      const repeatedLast = !prev && last && turn.last && sameUsage(last, turn.last);
      turn.last = last;
      if (last) {
        turn.readings.set(key, "seen");
        return repeatedLast ? undefined : toTurnUsage(last, context, model);
      }
      if (!turn.useCumulative || !prev) {
        turn.readings.set(key, "awaiting-last");
        return undefined;
      }
      const amount = toTurnUsage(cumulativeDelta(total, prev), context, model);
      turn.readings.set(key, !turn.completed && amount ? amount : "seen");
      return turn.completed ? amount : undefined;
    }

    if (!total) return last ? toTurnUsage(last, context, model) : undefined;
    if (prev && sameUsage(total, prev)) return undefined;
    this.#prevTotal = total;
    if (!prev || reset) return toTurnUsage(last ?? total, context, model);
    return toTurnUsage(
      cumulativeDelta(total, prev, last?.reasoningOutputTokens ?? total.reasoningOutputTokens),
      context,
      model,
    );
  }

  #resumeTurn(id: string): ResumedTurnUsage {
    if (this.#resumedTurn?.id !== id) {
      this.#resumedTurn = {
        id,
        baseline: this.#prevTotal,
        baselineTurnId: this.#prevTotalTurnId,
        useCumulative: this.#prevTotal !== undefined,
        completed: false,
        last: undefined,
        readings: new Map(),
        earlierUsage: undefined,
      };
    }
    return this.#resumedTurn;
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
