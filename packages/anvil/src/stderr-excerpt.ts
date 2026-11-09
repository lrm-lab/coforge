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

/** Whether cutting `text` at `index` would leave half a surrogate pair on either side. Both
 * callers cut a budget out of unknown provider text, whose characters need not be in the BMP, and
 * a lone surrogate is a replacement character to whoever reads the log or the error message. */
export function splitsSurrogatePair(text: string, index: number): boolean {
  const high = text.charCodeAt(index - 1);
  const low = text.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/** The head of `line` in at most `max` UTF-16 units, never splitting a surrogate pair. */
function headWithin(line: string, max: number): string {
  return line.slice(0, splitsSurrogatePair(line, max) ? max - 1 : max);
}

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
      return headWithin(line, max);
    }
    kept.unshift(line);
    used += cost;
  }
  return kept.join("\n");
}

/**
 * Puts the process's scrubbed stderr tail on a failed session call, and keeps the same error so
 * its code stays. An empty tail leaves the error as it was. A frozen message stays unchanged: the
 * process log still has the newest diagnostics.
 */
export function attachStderrExcerpt(source: StderrSource, error: unknown): void {
  if (!(error instanceof Error)) return;
  const excerpt = source.stderrExcerpt();
  if (!excerpt || error.message.includes(excerpt)) return;
  const message = `${error.message}\n${excerpt}`;
  try {
    error.message = message;
  } catch {
    // The message property is not writable. The runtime error event still carries its code.
  }
}
