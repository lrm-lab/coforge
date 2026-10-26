import { piProvider } from "./fixtures/pi-host";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeModelNotFoundError } from "@lrm/coforge-anvil";
import { CoforgeProvider } from "#src/code-agent/pi/provider";

for (const provider of ["pi", "coforge"] as const) {
  test(`${provider} preserves the SDK launch failure type and requested model`, async () => {
    const root = await mkdtemp(join(tmpdir(), `coforge-${provider}-launch-error-`));
    const model = `missing-${provider}-${crypto.randomUUID()}`;
    const runtime = provider === "pi" ? piProvider() : new CoforgeProvider();
    try {
      const error = await runtime
        .createAgentSession({
          agentWorkspaceDirectory: root,
          instructions: "Launch failure characterization.",
          // The missing-model classification uses the bundled catalog, not a network refresh.
          environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "host-agent") },
          runtime: {
            provider,
            modelProvider: "deepseek",
            model,
            reasoning: "",
            providerConfig: { kind: "coforge", providerId: "deepseek", apiKey: "test-key" },
          },
        })
        .then(
          async (session) => {
            await session.dispose();
            throw new Error("The missing model unexpectedly launched");
          },
          (error: unknown) => error,
        );
      expect(error).toBeInstanceOf(RuntimeModelNotFoundError);
      expect(error).toMatchObject({ code: "model_not_found", model });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
