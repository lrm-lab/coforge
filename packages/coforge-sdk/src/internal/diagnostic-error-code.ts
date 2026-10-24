/** A safe, low-cardinality error identifier for structured logs. */
export function diagnosticErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return diagnosticErrorName(error);
}

/** The error's class name for a structured log, ignoring any `code` it carries; never its
 * message, which may hold private text. */
export function diagnosticErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
