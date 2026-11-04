import { piProvider } from "./fixtures/pi-host";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelProviderSettingError, RuntimeModelNotFoundError } from "@lrm/coforge-anvil";
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

describe("Coforge providerConfig", () => {
  // A missing or defaulted provider config must reach model resolution, not be
  // refused: launches before provider selection used the local defaults, and
  // configs whose row lacks the field degrade to `kind: "default"`.
  for (const providerConfig of [undefined, { kind: "default" } as const]) {
    test(`launches with defaults when providerConfig is ${providerConfig ? '"default"' : "absent"}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "coforge-provider-config-default-"));
      const model = `missing-${crypto.randomUUID()}`;
      try {
        const error = await new CoforgeProvider()
          .createAgentSession({
            agentWorkspaceDirectory: root,
            instructions: "Launch failure characterization.",
            environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "host-agent") },
            runtime: {
              provider: "coforge",
              modelProvider: "deepseek",
              model,
              reasoning: "",
              ...(providerConfig ? { providerConfig } : {}),
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

  test("a coforge providerConfig still validates its key and provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "coforge-provider-config-invalid-"));
    try {
      const missingKey = await new CoforgeProvider()
        .createAgentSession({
          agentWorkspaceDirectory: root,
          instructions: "Launch failure characterization.",
          environment: { PI_OFFLINE: "1" },
          runtime: {
            provider: "coforge",
            modelProvider: "deepseek",
            model: "some-model",
            reasoning: "",
            providerConfig: { kind: "coforge", providerId: "deepseek" },
          },
        })
        .then(
          async (session) => {
            await session.dispose();
            throw new Error("A keyless coforge config unexpectedly launched");
          },
          (error: unknown) => error,
        );
      expect(missingKey).toBeInstanceOf(ModelProviderSettingError);
      expect(missingKey).toMatchObject({ message: "CoForge runtime provider API key is required" });

      const mismatch = await new CoforgeProvider()
        .createAgentSession({
          agentWorkspaceDirectory: root,
          instructions: "Launch failure characterization.",
          environment: { PI_OFFLINE: "1" },
          runtime: {
            provider: "coforge",
            modelProvider: "openai",
            model: "some-model",
            reasoning: "",
            providerConfig: { kind: "coforge", providerId: "deepseek", apiKey: "k" },
          },
        })
        .then(
          async (session) => {
            await session.dispose();
            throw new Error("A mismatched coforge config unexpectedly launched");
          },
          (error: unknown) => error,
        );
      expect(mismatch).toBeInstanceOf(ModelProviderSettingError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
