import { join } from "node:path";
import { PiRequestLogWriter } from "./pi-request-log";

const requestLogDirectories = new Map<string, string>();

export function registerContextViewRequestLogDirectory(
  sessionDir: string,
  requestLogDirectory: string,
): void {
  requestLogDirectories.set(sessionDir, requestLogDirectory);
}

export function clearContextViewRequestLogDirectory(sessionDir: string): void {
  requestLogDirectories.delete(sessionDir);
}

export function contextViewRequestLogFields(sessionDir: string): {
  contextViewRequestLog: PiRequestLogWriter;
  contextViewRequestLogPath: string;
} {
  const requestLogDirectory = requestLogDirectories.get(sessionDir);
  requestLogDirectories.delete(sessionDir);
  const contextViewRequestLogPath = requestLogDirectory
    ? join(requestLogDirectory, "session.jsonl")
    : join(sessionDir, "pi-requests.jsonl");
  return {
    contextViewRequestLog: new PiRequestLogWriter(contextViewRequestLogPath),
    contextViewRequestLogPath,
  };
}
