import { splitsSurrogatePair } from "./stderr-excerpt";

/** A short, single-line, bounded excerpt of a CLI diagnostic; redacts anything that looks like a
 * token or credential before it ever reaches a log. The one rule the ACP catalogs share: only the
 * first stderr line of a failed discovery is kept, and never in full. */
export function scrubStderrHint(line: string): string {
  const scrubbed = line
    .trim()
    .replace(/(?:sk|pk|api|token|key|secret)[_-]?[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  // The cut is 200 UTF-16 units, and CLI diagnostics are not always in the BMP: half a surrogate
  // pair reads as a replacement character in the log.
  return scrubbed.slice(0, splitsSurrogatePair(scrubbed, 200) ? 199 : 200);
}
