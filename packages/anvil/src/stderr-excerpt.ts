import { MAX_VISIBLE_ERROR_CHARS } from "@lrm/coforge-sdk/internal";

type StderrSource = {
  stderrExcerpt(): string;
};

/** Room kept for the failing call's own sentence inside `MAX_VISIBLE_ERROR_CHARS`, so a cut of the
 * whole message never lands inside the excerpt: the longest such sentence here is under 40
 * characters ("opencode acp session/new timed out"). */
const EXCERPT_SENTENCE_RESERVE = 64;

/** The excerpt's share of a visible error message. */
export const STDERR_EXCERPT_MAX_CHARS = MAX_VISIBLE_ERROR_CHARS - EXCERPT_SENTENCE_RESERVE;

/**
 * The newest whole lines of a stderr tail that fit `max`, kept in their arrival order.
 *
 * A visible error message is cut from its start, and a runtime's routine narrative arrives first
 * while the line that says what it was doing when it stopped arrives last — so taking the head
 * would drop exactly that line (task #683: the `watcher subscribe` that names a stalled path). One
 * line longer than the whole budget is cut, since the alternative is reporting nothing.
 */
export function newestLinesWithin(lines: readonly string[], max: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > max) {
      if (kept.length > 0) break;
      return line.slice(0, max);
    }
    kept.unshift(line);
    used += cost;
  }
  return kept.join("\n");
}

/**
 * Puts the process's scrubbed stderr tail on a failed session call, and keeps the same error so
 * its code stays. An empty tail leaves the error as it was. A frozen message stays unchanged: the
 * process log still has the tail.
 */
export function attachStderrExcerpt(source: StderrSource, error: unknown): void {
  if (!(error instanceof Error)) return;
  const excerpt = source.stderrExcerpt();
  if (!excerpt || error.message.includes(excerpt)) return;
  const message = `${error.message}\n${excerpt}`;
  try {
    error.message = message;
  } catch {
    // The message property is not writable. The failure log still carries the head.
  }
}
