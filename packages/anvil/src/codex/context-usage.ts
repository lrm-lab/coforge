import { asRecord } from "#src/json-record";

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The context a `thread/tokenUsage/updated` notification reports, as Raft 1.0.59 (oar 0.76) reads
 * it: the last model request's `totalTokens` against `modelContextWindow`. The thread's `total`
 * is cumulative across every request and outgrows the window within a few turns, so it is never
 * the context. No reading without a window, from a synthetic zero (Codex writes one around
 * compaction), or from a count past the window (old rollouts can carry one; openai/codex#24089).
 * Shape: `ThreadTokenUsage`, from `codex app-server generate-ts` (codex-cli 0.165.0).
 */
export function codexContextUsage(
  params: Readonly<Record<string, unknown>> | undefined,
): { usedTokens: number; windowTokens: number } | undefined {
  const usage = asRecord(params?.tokenUsage);
  const usedTokens = positive(asRecord(usage?.last)?.totalTokens);
  const windowTokens = positive(usage?.modelContextWindow);
  if (usedTokens === undefined || windowTokens === undefined || usedTokens > windowTokens) return;
  return { usedTokens, windowTokens };
}
