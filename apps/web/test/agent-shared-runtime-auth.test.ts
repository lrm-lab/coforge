import { expect, test } from "bun:test";
import { hasOwnRuntimeLogin } from "@lrm/coforge-anvil";
import type {
  AgentRuntimeConfig,
  EncryptedAgentEnvironment,
} from "#src/server/agents/agent-runtime-config.server";
import { agentRuntimeAuthSource } from "#src/server/computers/agent-shared-runtime-auth.server";

const TEST_KEY = new Uint8Array(32).fill(7);
const WRONG_KEY = new Uint8Array(32).fill(9);

async function sealEnv(
  agentId: string,
  envVars: Record<string, string>,
): Promise<EncryptedAgentEnvironment> {
  const nonce = new Uint8Array(12).fill(3);
  const key = await crypto.subtle.importKey("raw", TEST_KEY, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce,
      additionalData: new TextEncoder().encode(`coforge.agent-environment.v1\0${agentId}`),
    },
    key,
    new TextEncoder().encode(JSON.stringify(envVars)),
  );
  return {
    keyId: "v1",
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    nonce: Buffer.from(nonce).toString("base64"),
  };
}

function baseConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    runtime: "claude-code",
    provider: { kind: "default" },
    model: "",
    modelProvider: "",
    reasoning: "",
    ...overrides,
  };
}

test("hasOwnRuntimeLogin detects provider-specific credential and home overrides", () => {
  expect(hasOwnRuntimeLogin("claude-code", { ANTHROPIC_AUTH_TOKEN: "tok" })).toBe(true);
  expect(hasOwnRuntimeLogin("claude-code", { CLAUDE_CONFIG_DIR: "/alt/claude" })).toBe(true);
  expect(hasOwnRuntimeLogin("claude-code", { HOME: "/alt/home" })).toBe(true);
  expect(hasOwnRuntimeLogin("claude-code", { OPENAI_API_KEY: "sk-123" })).toBe(false);
  expect(hasOwnRuntimeLogin("codex", { OPENAI_API_KEY: "sk-123" })).toBe(true);
  expect(hasOwnRuntimeLogin("codex", { CODEX_HOME: "/alt/codex" })).toBe(true);
  expect(hasOwnRuntimeLogin("grok", { GROK_HOME: "/alt/grok" })).toBe(true);
  expect(hasOwnRuntimeLogin("claude-code", { OTHER_VAR: "1", ANTHROPIC_AUTH_TOKEN: "   " })).toBe(
    false,
  );
});

test("agentRuntimeAuthSource distinguishes shared, own, usage-only metered runtimes (Grok), and unknown on decrypt failure", async () => {
  const readKey = async () => TEST_KEY;

  expect(await agentRuntimeAuthSource("a1", baseConfig(), readKey)).toBe("shared");
  expect(await agentRuntimeAuthSource("a1", undefined, readKey)).toBe("unknown");
  expect(await agentRuntimeAuthSource("a1", baseConfig({ runtime: "pi" }), readKey)).toBe("own");
  expect(
    await agentRuntimeAuthSource(
      "a1",
      baseConfig({ provider: { kind: "coforge", providerId: "anthropic" } }),
      readKey,
    ),
  ).toBe("own");

  expect(await agentRuntimeAuthSource("g1", baseConfig({ runtime: "grok" }), readKey)).toBe(
    "shared",
  );
  const grokOwnHome = await sealEnv("g-own", { GROK_HOME: "/alt/grok" });
  expect(
    await agentRuntimeAuthSource(
      "g-own",
      baseConfig({ runtime: "grok", environment: grokOwnHome }),
      readKey,
    ),
  ).toBe("own");

  const ownTokenEnv = await sealEnv("a-own", { ANTHROPIC_AUTH_TOKEN: "secret-token" });
  expect(
    await agentRuntimeAuthSource("a-own", baseConfig({ environment: ownTokenEnv }), readKey),
  ).toBe("own");

  const unrelatedEnv = await sealEnv("a-other", { FOO: "bar" });
  expect(
    await agentRuntimeAuthSource("a-other", baseConfig({ environment: unrelatedEnv }), readKey),
  ).toBe("shared");

  expect(
    await agentRuntimeAuthSource(
      "a-own",
      baseConfig({ environment: ownTokenEnv }),
      async () => undefined,
    ),
  ).toBe("unknown");
  expect(
    await agentRuntimeAuthSource(
      "a-own",
      baseConfig({ environment: ownTokenEnv }),
      async () => WRONG_KEY,
    ),
  ).toBe("unknown");
});
