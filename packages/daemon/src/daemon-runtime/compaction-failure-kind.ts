import type { CompactionFailureKind } from "./agent-contexts";

/**
 * How a runtime error that arrives while a compaction is open counts, following Raft's
 * `compactionFailureKind(event, compaction)`. A cancelled compaction is not an error and never
 * reaches this function — only the runtime's own failure events do.
 */
export function compactionFailureKind(message: string, attempts: number): CompactionFailureKind {
  // An input too large does not shrink by retrying, so the attempt itself is spent.
  if (/input too large|too many tokens|context (length|window) exceeded/i.test(message))
    return "compaction_input_too_large";
  // A second failure with the same compaction still open means its recovery did not help.
  return attempts > 1 ? "compaction_recovery_exhausted" : "compaction_failed";
}
