import { asRecord } from "#src/json-record";

function count(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

/**
 * The context a `thread/tokenUsage/updated` notification reports, as Raft 1.0.59 (oar 0.76) reads
 * it: the last model request's `totalTokens` against `modelContextWindow`. The thread's `total`
 * is cumulative across every request and outgrows the window within a few turns, so it is never
 * the context. No reading without a window. A zero (Codex writes one around compaction) or a
 * count past the window is reported as is, like Raft (0% / over 100%).
 * Shape: `ThreadTokenUsage`, from `codex app-server generate-ts` (codex-cli 0.165.0).
 */
export function codexContextUsage(
  params: Readonly<Record<string, unknown>> | undefined,
): { usedTokens: number; windowTokens: number } | undefined {
  const usage = asRecord(params?.tokenUsage);
  const usedTokens = count(asRecord(usage?.last)?.totalTokens, 0);
  const windowTokens = count(usage?.modelContextWindow, 1);
  if (usedTokens === undefined || windowTokens === undefined) return;
  return { usedTokens, windowTokens };
}
