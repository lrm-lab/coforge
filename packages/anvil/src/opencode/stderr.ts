/** `opencode acp --print-logs` lines look like `timestamp=… level=INFO …`; TRACE/DEBUG/INFO is
 * the runtime's routine narrative, not a diagnostic. WARN and above — and anything outside the
 * log format, like a panic or a node error — is what a failure should quote. */
const ROUTINE_LOG_LINE = /^timestamp=\S+ level=(?:TRACE|DEBUG|INFO)\b/;

export function isRoutineOpenCodeStderr(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || ROUTINE_LOG_LINE.test(trimmed);
}
