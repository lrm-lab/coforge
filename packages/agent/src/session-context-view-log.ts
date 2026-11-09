import { basename, dirname, join } from "node:path";
import { PiRequestLogWriter } from "./pi-request-log";

const CONTEXT_VIEW_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function contextViewRequestLogFields(
  sessionDir: string,
  requestLogDirectory?: string,
  sessionId?: string,
): {
  contextViewRequestLog: PiRequestLogWriter;
  contextViewRequestLogPath: string;
} {
  if (requestLogDirectory && (!sessionId || !CONTEXT_VIEW_SESSION_ID.test(sessionId)))
    throw new Error("Invalid context view session ID");
  const contextViewRequestLogPath = requestLogDirectory
    ? join(requestLogDirectory, `${sessionId}.jsonl`)
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
