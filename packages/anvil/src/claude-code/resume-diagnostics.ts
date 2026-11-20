function missingSessionDiagnostic(sessionId: string): string {
  return `No conversation found with session ID: ${sessionId}`;
}

export function isClaudeMissingSessionLine(line: string, sessionId: string): boolean {
  return line.trim() === missingSessionDiagnostic(sessionId);
}

export function isClaudeMissingSessionResult(
  record: Readonly<Record<string, unknown>>,
  sessionId: string,
): boolean {
  return (
    record.type === "result" &&
    record.subtype === "error_during_execution" &&
    record.is_error === true &&
    Array.isArray(record.errors) &&
    record.errors.length === 1 &&
    record.errors[0] === missingSessionDiagnostic(sessionId)
  );
}
