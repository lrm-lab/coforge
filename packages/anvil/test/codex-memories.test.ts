import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-memories-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function provider(): CodexProvider {
  return new CodexProvider({
    host: fixtureCodexHost,
    command: [
      process.execPath,
      new URL("./fixtures/codex-app-server-scenarios.ts", import.meta.url).pathname,
      `log=${join(directory, "requests.jsonl")}`,
    ],
  });
}

async function threadConfig(method: "thread/start" | "thread/resume") {
  const log = await readFile(join(directory, "requests.jsonl"), "utf8");
  const request = log
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> })
    .find((entry) => entry.method === method);
  return request?.params?.config as Record<string, unknown> | undefined;
}

for (const method of ["thread/start", "thread/resume"] as const) {
  test(`Codex ${method} disables built-in memories`, async () => {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: "Test Agent instructions.",
      environment: { HOME: "/home/fixture", CODEX_HOME: "/home/fixture/.codex" },
      sessionId: method === "thread/resume" ? "thread-1" : undefined,
    });
    try {
      const config = await threadConfig(method);
      expect(config?.["features.memories"]).toBe(false);
      expect(config?.["memories.use_memories"]).toBe(false);
      expect(config?.["memories.generate_memories"]).toBe(false);
    } finally {
      await session.dispose();
    }
  });
}
