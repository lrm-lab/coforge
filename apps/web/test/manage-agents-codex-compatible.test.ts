import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { fixture } from "./fixtures/manage-agents";

test("creates and edits a Codex compatible Agent with a private key bound to its endpoint", async () => {
  const principal = { userId: "user-1", workspaceId: "workspace-1", role: "admin" } as const;
  const { agentManagement, records, starts } = fixture();
  const apiKey = "fixture-compatible-value";
  const base = {
    name: "compatible",
    displayName: "Compatible",
    description: "",
    provider: RUNTIME_PROVIDER.CODEX,
    computerId: "computer-1",
    modelProvider: "openai-compatible",
    model: "gateway-model",
    baseUrl: "https://gateway.example/v1",
  };
  await expect(agentManagement.create(principal, base)).rejects.toThrow();
  expect(records).toHaveLength(0);
  const created = await agentManagement.create(principal, { ...base, apiKey });
  expect(created.agent.runtimeConfig?.provider).toEqual({
    kind: "codex-compatible",
    baseUrl: base.baseUrl,
    hasKey: true,
  });
  expect(JSON.stringify(starts)).not.toContain(apiKey);
  expect(JSON.stringify(records)).not.toContain(apiKey);
  const edit = { ...base, agentId: created.agent.id };
  await expect(
    agentManagement.update(principal, {
      ...edit,
      baseUrl: "https://another.example/v1",
    }),
  ).rejects.toThrow();
  expect(records[0]?.runtimeConfig?.provider).toMatchObject({ baseUrl: base.baseUrl });
  const edited = await agentManagement.update(principal, { ...edit, model: "next-model" });
  expect(edited.agent.runtimeConfig?.provider).toEqual({
    kind: "codex-compatible",
    baseUrl: base.baseUrl,
    hasKey: true,
  });
  const shared = await agentManagement.update(principal, {
    ...edit,
    modelProvider: "",
    baseUrl: undefined,
  });
  expect(shared.agent.runtimeConfig?.provider).toEqual({ kind: "default" });
});
