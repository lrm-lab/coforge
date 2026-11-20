import { readMemoryFile } from "./memory-files";
import type { MemoryReviewBatch } from "#src/persistence/memory-review-ledger";

export const MEMORY_REVIEW_RECEIPT_PATH = "notes/.memory-review-receipt.json";
export type MemoryReviewReceipt = { batchId: string; reviewed: string[] };

export async function readMemoryReviewReceipt(
  root: string,
): Promise<MemoryReviewReceipt | undefined> {
  const text = await readMemoryFile(root, MEMORY_REVIEW_RECEIPT_PATH, 4096);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as MemoryReviewReceipt;
    return typeof value.batchId === "string" &&
      Array.isArray(value.reviewed) &&
      value.reviewed.length <= 5 &&
      value.reviewed.every((key) => typeof key === "string")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function memoryReviewPrompt(batch: MemoryReviewBatch, now: number): string {
  return [
    "[CoForge personal memory review — low priority]",
    `Review only these changed personal memory keys (at most 5): ${JSON.stringify(batch.entries)}.`,
    `Aim to finish within 2 minutes, by ${new Date(now + 120_000).toISOString()}. If a person gives you work, stop this review and do their work first.`,
    "Use coforge memory get to read each current entry and its source; memory search may find a duplicate. Do not crawl chat history or review unrelated notes.",
    "Keep only reusable knowledge. Merge duplicates with their sources, resolve contradictions only with evidence, and preserve uncertainty otherwise. Use coforge memory save/archive with the current revision so history remains recoverable. Never delete memory files or history directly.",
    "If a changed entry could help the team, keep only a short candidate and its accessible public source in notes/team-memory-candidates.md locally. Deduplicate candidates. Do not send or save team memory, expose private chats, or copy personal notes wholesale.",
    `When finished (including a justified no-change decision), write ${MEMORY_REVIEW_RECEIPT_PATH} as JSON: ${JSON.stringify({ batchId: batch.id, reviewed: batch.entries.map((entry) => entry.key) })}. List ONLY keys actually reviewed; use fewer when interrupted. Do not mark unfinished work complete.`,
    "Do not message people or create tasks, reminders, or new memory solely to report this review. End quietly when done.",
  ].join("\n");
}
