import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { fixtureCodexHost } from "./fixtures/codex-host";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-env-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const CODEX_HOME = "/home/fixture/.codex";

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

// A shell Codex launches inherits what the session was launched with; the policy only keeps
// Codex's own KEY/SECRET/TOKEN exclusions. An include list here once dropped XDG_RUNTIME_DIR and
// DBUS_SESSION_BUS_ADDRESS, which left `systemctl --user` with no user bus on Linux.
for (const method of ["thread/start", "thread/resume"] as const) {
  test(`a ${method} shell inherits the environment, bar the default secret exclusions`, async () => {
    const session = await provider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: "Test Agent instructions.",
      environment: { HOME: "/home/fixture", CODEX_HOME },
      sessionId: method === "thread/resume" ? "thread-1" : undefined,
    });
    try {
      expect((await threadConfig(method))?.shell_environment_policy).toEqual({
        inherit: "all",
        ignore_default_excludes: false,
      });
    } finally {
      await session.dispose();
    }
  });
}
