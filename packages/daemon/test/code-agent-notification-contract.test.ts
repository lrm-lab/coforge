import { anvilRuntimeFixtures } from "./fixtures/anvil-runtime";
import { codexRuntimeHost } from "#src/code-agent/codex/host";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";

const command = (fixture: string) => [
  process.execPath,
  fixture === "codex-app-server.ts"
    ? anvilRuntimeFixtures.codex
    : new URL(`./fixtures/${fixture}`, import.meta.url).pathname,
];
const providers = [
  new CodexProvider({ host: codexRuntimeHost, command: command("codex-app-server.ts") }),
  new ClaudeCodeProvider({ command: command("claude-stream-json.ts") }),
];

for (const provider of providers) {
  test(`${provider.provider}: notification acceptance is independent of run completion`, async () => {
    const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-notification-contract-"));
    const session = await provider.createAgentSession({
      agentWorkspaceDirectory,
      instructions: "Test Agent instructions.",
      environment: { COFORGE_DECLARED_TEST_VALUE: "allowed" },
    });
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.notify!("wait");
      await expect(session.sendMessage("overlap")).rejects.toThrow();
      expect(events.filter((event) => event.type === "completed")).toEqual([]);
      // Busy delivery timing is provider-specific and covered by adapter tests.
      await session.dispose();
      await expect(session.notify!("after disposal")).rejects.toThrow();
    } finally {
      await session.dispose();
      await rm(agentWorkspaceDirectory, { recursive: true, force: true });
    }
  });
}
