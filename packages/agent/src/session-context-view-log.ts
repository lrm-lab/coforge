import { join } from "node:path";
import { PiRequestLogWriter } from "./pi-request-log";

export function contextViewRequestLogFields(sessionDir: string): {
  contextViewRequestLog: PiRequestLogWriter;
  contextViewRequestLogPath: string;
} {
  const contextViewRequestLogPath = join(sessionDir, "pi-requests.jsonl");
  return {
    contextViewRequestLog: new PiRequestLogWriter(contextViewRequestLogPath),
    contextViewRequestLogPath,
  };
}
