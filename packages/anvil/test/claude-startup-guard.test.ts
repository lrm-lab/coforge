import { describe, expect, test } from "bun:test";
import {
  CLAUDE_HOST_PROVIDER_ENV_KEYS,
  ClaudeCodeProvider,
  ClaudeStartupPromptBudgetError,
  assertClaudeStartupPromptWithinBudget,
  estimateStartupPromptTokens,
  withoutHostClaudeProviderEnv,
} from "@lrm/coforge-anvil/claude-code";
import { fixtureClaudeHost } from "./fixtures/claude-host";

describe("withoutHostClaudeProviderEnv", () => {
  test("strips undeclared host cloud-provider, model-alias, and Anthropic overrides case-insensitively", () => {
    const inherited: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home/dev",
      CUSTOM_APP_FLAG: "keep",
      ANTHROPIC_API_KEY: "host-key",
      ANTHROPIC_AUTH_TOKEN: "host-token",
      ANTHROPIC_BASE_URL: "https://corp-gateway.example",
      anthropic_model: "claude-opus-host",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "us.anthropic.claude-sonnet-4-6-v1:0",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "us.anthropic.claude-opus-4-6-v1:0",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-v1:0",
      CLAUDE_CODE_SUBAGENT_MODEL: "us.anthropic.claude-sonnet-4-6-v1:0",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
      CLAUDE_CODE_USE_VERTEX: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj-1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_USE_GATEWAY: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
    };

    const scrubbed = withoutHostClaudeProviderEnv(inherited);
    expect(scrubbed.PATH).toBe("/usr/bin");
    expect(scrubbed.HOME).toBe("/home/dev");
    expect(scrubbed.CUSTOM_APP_FLAG).toBe("keep");
    for (const key of CLAUDE_HOST_PROVIDER_ENV_KEYS) {
      expect(scrubbed[key]).toBeUndefined();
    }
    expect(scrubbed.anthropic_model).toBeUndefined();
  });
});

describe("startup prompt token budget guard", () => {
  test("estimates CJK text at a higher token density than ASCII", () => {
    const asciiTokens = estimateStartupPromptTokens("a".repeat(4_000));
    const cjkTokens = estimateStartupPromptTokens("你".repeat(4_000));
    expect(asciiTokens).toBe(1_000);
    expect(cjkTokens).toBeGreaterThan(2_500);
  });

  test("rejects oversized startup instructions with typed ClaudeStartupPromptBudgetError", () => {
    expect(() =>
      assertClaudeStartupPromptWithinBudget("normal instructions", { model: "sonnet" }),
    ).not.toThrow();

    const hugeAscii = "x".repeat(700_000);
    let caught: unknown;
    try {
      assertClaudeStartupPromptWithinBudget(hugeAscii, { model: "sonnet" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClaudeStartupPromptBudgetError);
    expect((caught as ClaudeStartupPromptBudgetError).code).toBe("startup_prompt_too_large");

    expect(() =>
      assertClaudeStartupPromptWithinBudget(hugeAscii, {
        model: "claude-opus-4-6[1m]",
        autoCompactWindow: 512_000,
      }),
    ).not.toThrow();

    expect(() =>
      assertClaudeStartupPromptWithinBudget(hugeAscii, {
        model: "sonnet",
        contextWindow: 1_000_000,
      }),
    ).not.toThrow();

    expect(() =>
      assertClaudeStartupPromptWithinBudget(hugeAscii, {
        model: "sonnet",
        autoCompactWindow: Number.NaN,
      }),
    ).toThrow(ClaudeStartupPromptBudgetError);

    expect(() =>
      assertClaudeStartupPromptWithinBudget("x".repeat(50_000), {
        model: "sonnet",
        contextWindow: 10_000,
      }),
    ).toThrow(ClaudeStartupPromptBudgetError);

    const hugeCjk = "中".repeat(250_000);
    expect(() => assertClaudeStartupPromptWithinBudget(hugeCjk, { model: "sonnet" })).toThrow(
      ClaudeStartupPromptBudgetError,
    );
  });

  test("ClaudeCodeProvider removes prompt file and does not spawn when startup budget is exceeded", async () => {
    let promptRemoved = false;
    let spawned = false;
    const provider = new ClaudeCodeProvider({
      host: {
        ...fixtureClaudeHost,
        processTreeSpawner: {
          spawn: () => {
            spawned = true;
            throw new Error("should not spawn");
          },
        },
        createPromptFile: async (text) => {
          const handle = await fixtureClaudeHost.createPromptFile(text);
          return {
            path: handle.path,
            remove: async () => {
              promptRemoved = true;
              await handle.remove();
            },
          };
        },
      },
    });

    await expect(
      provider.createAgentSession({
        agentWorkspaceDirectory: "/tmp",
        instructions: "x".repeat(700_000),
        runtime: { provider: "claude-code", model: "sonnet", reasoning: "medium" },
      }),
    ).rejects.toThrow(ClaudeStartupPromptBudgetError);

    expect(promptRemoved).toBe(true);
    expect(spawned).toBe(false);
  });
});
