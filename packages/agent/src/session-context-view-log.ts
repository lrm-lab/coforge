import { basename, dirname, join } from "node:path";
import { PiRequestLogWriter } from "./pi-request-log";

export function contextViewRequestLogFields(
  sessionDir: string,
  requestLogDirectory?: string,
  sessionId?: string,
): {
  contextViewRequestLog: PiRequestLogWriter;
  contextViewRequestLogPath: string;
} {
  const contextViewRequestLogPath = requestLogDirectory
    ? join(requestLogDirectory, `${sessionId ?? "session"}.jsonl`)
    : join(sessionDir, "pi-requests.jsonl");
  const trustedRoot = requestLogDirectory ? managedRequestLogRoot(requestLogDirectory) : undefined;
  return {
    contextViewRequestLog: new PiRequestLogWriter(contextViewRequestLogPath, trustedRoot),
    contextViewRequestLogPath,
  };
}

function managedRequestLogRoot(directory: string): string | undefined {
  let current = directory;
  while (current !== dirname(current)) {
    if (basename(current) === "agent-context") return dirname(current);
    current = dirname(current);
  }
  return undefined;
}
