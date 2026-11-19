import { TASK_MEMORY_RECALL_MS } from "#src/server/tasks/task-memory-recall.server";

export const RETRIEVAL_LIMIT = 5;

export function fuseRetrievalRanks(lexical: readonly string[], semantic: readonly string[]) {
  const scores = new Map<string, number>();
  for (const ranking of [lexical, semantic]) {
    for (const [index, id] of ranking.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (61 + index));
    }
  }
  return [...scores.keys()]
    .sort((a, b) => scores.get(b)! - scores.get(a)!)
    .slice(0, RETRIEVAL_LIMIT);
}

type RetrievalResult = {
  relevant: readonly string[];
  obsolete: readonly string[];
  ranked: readonly string[];
  ms: number;
};

export function summarizeRetrieval(results: readonly RetrievalResult[]) {
  const latencies = results.map(({ ms }) => ms).sort((a, b) => a - b);
  let recall = 0;
  let obsolete = 0;
  for (const result of results) {
    const top = new Set(result.ranked.slice(0, RETRIEVAL_LIMIT));
    recall += result.relevant.filter((id) => top.has(id)).length / result.relevant.length;
    if (result.obsolete.some((id) => top.has(id))) obsolete++;
  }
  return {
    queries: results.length,
    recallAt5: recall / results.length,
    obsoleteAt5: obsolete / results.length,
    overBudget: latencies.filter((ms) => ms > TASK_MEMORY_RECALL_MS).length,
    p50Ms: latencies[Math.ceil(latencies.length * 0.5) - 1],
    p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1],
  };
}
