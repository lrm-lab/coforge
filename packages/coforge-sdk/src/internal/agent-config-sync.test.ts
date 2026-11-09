import { expect, test } from "bun:test";
import { decodeAgentConfigSync, encodeAgentConfigSync } from "./agent-config-sync";

const value = {
  protocolMajor: 1 as const,
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  revision: 2,
  provider: "codex" as const,
  model: "gpt-5",
  modelProvider: "openai",
  reasoning: "high",
  fastMode: true,
  providerConfig: { kind: "coforge" as const, providerId: "openai" },
};

test("Agent config sync round trips only non-secret launch fields", () => {
  const decoded = decodeAgentConfigSync(encodeAgentConfigSync(value));
  expect(decoded).toEqual(value);
  expect(JSON.stringify(decoded)).not.toContain("apiKey");
  expect(JSON.stringify(decoded)).not.toContain("environment");
});

test("Agent config sync preserves omitted optional fields", () => {
  const {
    modelProvider: _modelProvider,
    fastMode: _fastMode,
    providerConfig: _providerConfig,
    ...minimal
  } = value;
  expect(decodeAgentConfigSync(encodeAgentConfigSync(minimal))).toEqual(minimal);
});

test("Agent config sync rejects invalid revisions and scope", () => {
  expect(() => encodeAgentConfigSync({ ...value, revision: 0 })).toThrow();
  expect(() => encodeAgentConfigSync({ ...value, agentId: "" })).toThrow();
});
