import { expect, test } from "bun:test";
import {
  parseAgentRuntimeConfig,
  requiredRuntimeConfig,
} from "#src/server/agents/agent-runtime-config.server";
import { agentStartIntent } from "#src/server/agents/manage-agents.server";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";
import { fixture } from "./fixtures/manage-agents";

// task #517: an unreadable stored runtimeConfig does not block the repair that replaces it —
// a full re-selection writes a new valid config and starts without reading the bad one.
test("a stored runtimeConfig that cannot be parsed is repaired by a full re-selection", async () => {
  const { agentManagement, records, starts } = fixture();
  records.push({
    id: "broken-agent",
    workspaceId: "workspace-1",
    ownerId: "user-1",
    name: "broken",
    displayName: "broken",
    computerId: "computer-1",
    runtimeConfig: { broken: true } as unknown as AgentRecord["runtimeConfig"],
    createdAt: new Date(),
  });

  const result = await agentManagement.update(
    { userId: "user-1", workspaceId: "workspace-1", role: "admin" as const },
    {
      agentId: "broken-agent",
      description: "",
      provider: RUNTIME_PROVIDER.PI,
      computerId: "computer-1",
      modelProvider: "anthropic",
    },
  );

  expect(result.restart).toBe("published");
  expect(records[0]!.runtimeConfig).toMatchObject({ runtime: RUNTIME_PROVIDER.PI });
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    intent: { computerId: "computer-1", agentId: "broken-agent" },
    userId: "user-1",
  });
});

test("a stored runtimeConfig missing its provider launches on defaults", () => {
  // task #319: a config that predates `provider` is not corrupt — the daemon gets
  // `{kind:"default"}` and an info log, so the launch does not fail.
  const config = parseAgentRuntimeConfig({
    runtime: "pi",
    model: "sonnet",
    reasoning: "medium",
  });
  expect(config.provider).toEqual({ kind: "default" });
  expect(
    agentStartIntent({ id: "a", workspaceId: "w", computerId: "c", runtimeConfig: config }),
  ).toMatchObject({ providerConfig: { kind: "default" } });
});

test("a stored runtimeConfig that cannot be parsed still refuses the launch", () => {
  // task #319: a corrupt config keeps the readable path's CONFLICT + errorId — the owner
  // repairs it by choosing the runtime again on the Agent page (task #517).
  expect(() =>
    parseAgentRuntimeConfig({ runtime: "pi", model: "sonnet", reasoning: "medium", provider: 42 }),
  ).toThrow();
  expect(() => requiredRuntimeConfig({ runtimeConfig: undefined })).toThrow(
    expect.objectContaining({ errorId: "agent-runtime-config-unreadable" }),
  );
});
