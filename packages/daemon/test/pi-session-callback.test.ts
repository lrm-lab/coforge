import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionOptions } from "@lrm/coforge-anvil";
import { CoforgeProvider } from "#src/code-agent/pi/provider";
import { piProvider } from "./fixtures/pi-host";

for (const provider of ["pi", "coforge"] as const) {
  test(`${provider} calls the session ID hook with its original options receiver`, async () => {
    const root = await mkdtemp(join(tmpdir(), `coforge-${provider}-callback-`));
    let receiver: unknown;
    let calls = 0;
    let session: AgentSession | undefined;
    const options: AgentSessionOptions = {
      agentWorkspaceDirectory: root,
      instructions: "Session callback characterization.",
      environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "host") },
      ...(provider === "coforge"
        ? {
            runtime: {
              provider,
              modelProvider: "openrouter",
              model: "deepseek/deepseek-v4-flash-0731",
              reasoning: "",
              providerConfig: {
                kind: "coforge" as const,
                providerId: "openrouter",
                apiKey: "test-key",
              },
            },
          }
        : {}),
      async onSessionId() {
        receiver = this;
        calls += 1;
      },
    };
    try {
      const runtime = provider === "pi" ? piProvider() : new CoforgeProvider();
      session = await runtime.createAgentSession(options);
      expect(calls).toBe(1);
      expect(receiver).toBe(options);
    } finally {
      await session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
