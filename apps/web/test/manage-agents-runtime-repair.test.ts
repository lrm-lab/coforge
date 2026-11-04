import { expect, test } from "bun:test";
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
