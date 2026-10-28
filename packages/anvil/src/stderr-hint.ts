/** A short, single-line, bounded excerpt of a CLI diagnostic; redacts anything that looks like a
 * token or credential before it ever reaches a log. The one rule the ACP catalogs share: only the
 * first stderr line of a failed discovery is kept, and never in full. */
export function scrubStderrHint(line: string): string {
  return line
    .trim()
    .replace(/(?:sk|pk|api|token|key|secret)[_-]?[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}
