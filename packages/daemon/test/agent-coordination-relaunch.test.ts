import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProcessManager } from "#src/agent-runtime/agent-process-manager";
import type { AgentSessionOptions, AgentRuntimeConfig, AgentSession } from "@coforge/agent";

const config: AgentRuntimeConfig = { provider: "pi", model: "default", reasoning: "balanced" };
function sessionSpy(): AgentSession {
  return {
    sendMessage: async () => {},
    interrupt: async () => {},
    dispose: async () => {},
    subscribe: () => () => {},
    onExit: () => () => {},
  };
}

test.each(["resume", "create"] as const)(
  "a %s launch retains memory but injects current coordination boundaries",
  async (sessionMode) => {
    const workspace = await mkdtemp(join(tmpdir(), "coforge-coordinator-relaunch-"));
    const memory = "# coforge-lead\nI used to coordinate #team.\n";
    await writeFile(join(workspace, "MEMORY.md"), memory);
    let options: AgentSessionOptions | undefined;
    const manager = new AgentProcessManager(() => ({
      provider: "pi",
      async createAgentSession(input) {
        options = input;
        return sessionSpy();
      },
    }));
    try {
      await manager.start("lead", config, {
        agentWorkspaceDirectory: workspace,
        identity: { name: "coforge-lead", description: "Former team coordinator" },
        sessionMode,
        ...(sessionMode === "resume" ? { sessionId: "old-coordinator-session" } : {}),
      });
      expect(options?.instructions).toContain(
        "Current channel roles override names, history and memory",
      );
      expect(options?.sessionMode).toBe(sessionMode);
      expect(await readFile(join(workspace, "MEMORY.md"), "utf8")).toBe(memory);
    } finally {
      await manager.shutdown();
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
