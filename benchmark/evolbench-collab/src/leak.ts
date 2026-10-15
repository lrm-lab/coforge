import type { EpisodeResult } from "./eval-qa";

/** Same collaboration contract as the sibling evals: the Task Agent's answer
 * must ride on a cited Memory Offer (the recall). Grading is external; the
 * mechanism columns only document how the answer was produced. */
export function classifyMechanism(result: EpisodeResult): string {
  if (result.memoryLeakMessageIds.length > 0) return "leak";
  if (
    result.offerMessageId === null &&
    result.memoryRequestCount === 0 &&
    result.finalOutput?.trim() &&
    !result.timedOut
  )
    return "not_requested";
  if (result.offerMessageId === null) return "no_offer";
  if (result.citationCount < 1) return "uncited_offer";
  if (!result.finalOutput?.trim()) return "no_reply";
  if (result.timedOut) return "timeout";
  if (
    result.memoryHintIds?.some(
      (id) => !result.dispositions?.some((record) => record.hint_id === id),
    )
  )
    return "missing_disposition";
  return "ok";
}
