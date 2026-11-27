import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import type { AgentRuntimeConfig, AgentRuntimeEvent } from "@coforge/agent";
import { fixtureCodexHost } from "./fixtures/codex-host";

const runtime = {
  provider: "codex",
  model: "gateway-model",
  modelProvider: "openai-compatible",
  reasoning: "",
} satisfies AgentRuntimeConfig;

test("Codex configures the compatible provider before app-server initializes", async () => {
  const agentWorkspaceDirectory = await mkdtemp(join(tmpdir(), "coforge-codex-compatible-"));
  const agentKey = "fixture-agent-value";
  const baseUrl = "http://127.0.0.1:9999/v1";
  const command = [
    process.execPath,
    new URL("./fixtures/codex-compatible-app-server.ts", import.meta.url).pathname,
  ];
  const adapter = new CodexProvider({
    command,
    host: {
      ...fixtureCodexHost,
      processTreeSpawner: {
        spawn(args, cwd, environment, options) {
          expect(args.slice(command.length)).toEqual([
            "-c",
            'model_provider="openai-compatible"',
            "-c",
            'model_providers.openai-compatible.name="OpenAI-compatible"',
            "-c",
            'model_providers.openai-compatible.base_url="http://127.0.0.1:9999/v1"',
            "-c",
            'model_providers.openai-compatible.env_key="COFORGE_CODEX_COMPATIBLE_API_KEY"',
            "-c",
            "model_providers.openai-compatible.requires_openai_auth=false",
            "-c",
            'model_providers.openai-compatible.wire_api="responses"',
          ]);
          expect(environment.COFORGE_CODEX_COMPATIBLE_API_KEY).toBe(agentKey);
          expect(environment.OPENAI_API_KEY).toBeUndefined();
          expect(environment.OPENAI_BASE_URL).toBeUndefined();
          return fixtureCodexHost.processTreeSpawner.spawn(args, cwd, environment, options);
        },
      },
    },
  });
  try {
    const session = await adapter.createAgentSession({
      agentWorkspaceDirectory,
      instructions: "",
      environment: {
        OPENAI_API_KEY: "fixture-computer-value",
        OPENAI_BASE_URL: "https://other.example",
      },
      runtime: {
        ...runtime,
        codexCompatibleEnvironment: { OPENAI_API_KEY: agentKey, OPENAI_BASE_URL: baseUrl },
      },
    });
    try {
      const errors: AgentRuntimeEvent[] = [];
      const completed = Promise.withResolvers<void>();
      session.subscribe((event) => {
        if (event.type === "error") errors.push(event);
        if (event.type === "completed") completed.resolve();
      });
      await session.sendMessage("compatible-rate-limit");
      await completed.promise;
      expect(errors).toEqual([
        expect.objectContaining({
          message: "The API provider limited the request or token rate. Try again shortly.",
          providerLimit: { kind: "transient_rate_limit" },
        }),
      ]);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(agentWorkspaceDirectory, { recursive: true, force: true });
  }
});

test("Codex refuses incomplete compatible credentials before spawning", async () => {
  const adapter = new CodexProvider({
    host: {
      ...fixtureCodexHost,
      processTreeSpawner: {
        spawn() {
          throw new Error("Unexpected app-server spawn");
        },
      },
    },
  });
  await expect(
    adapter.createAgentSession({
      agentWorkspaceDirectory: tmpdir(),
      instructions: "",
      runtime: { ...runtime, envVars: { OPENAI_API_KEY: "fixture-agent-value" } },
    }),
  ).rejects.toThrow("Codex compatible provider requires an API key and a valid base URL");
});
