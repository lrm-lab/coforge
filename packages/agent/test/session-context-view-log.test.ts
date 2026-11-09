import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextViewRequestLogFields } from "../src/session-context-view-log";

test("managed request logs keep each actual provider session in its own file", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-context-session-log-"));
  try {
    const sessionDir = join(root, "sessions");
    const requestLogDir = join(root, "pi-requests");
    const first = contextViewRequestLogFields(sessionDir, requestLogDir, "session-1");
    const second = contextViewRequestLogFields(sessionDir, requestLogDir, "session-2");
    expect(first.contextViewRequestLogPath).toBe(join(requestLogDir, "session-1.jsonl"));
    expect(second.contextViewRequestLogPath).toBe(join(requestLogDir, "session-2.jsonl"));
    expect(first.contextViewRequestLogPath).not.toBe(second.contextViewRequestLogPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
