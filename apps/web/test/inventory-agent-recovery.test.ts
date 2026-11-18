import { expect, test } from "bun:test";
import type { RuntimeMetadata } from "@lrm/coforge-sdk/internal";
import { recoverAgentsAfterInventory } from "#src/server/agents/inventory-agent-recovery.server";

type FakeAgent = {
  id: string;
  provider: string;
  errorCode?: string;
  stoppedAt?: number;
  deletedAt?: number;
  migrating?: boolean;
};

function fleet(agents: FakeAgent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, { ...agent }]));
  const started: string[] = [];
  const ports = {
    failedAgentIds: async (provider: string, errorCode: string) =>
      [...byId.values()]
        .filter((agent) => agent.provider === provider && agent.errorCode === errorCode)
        .map((agent) => agent.id),
    clearLaunchFailure: async (agentId: string, errorCode: string) => {
      const agent = byId.get(agentId);
      if (!agent || agent.errorCode !== errorCode) return false;
      delete agent.errorCode;
      return true;
    },
    agent: async (agentId: string) => byId.get(agentId),
    start: async (agent: FakeAgent) => {
      started.push(agent.id);
    },
  };
  return { ports, started, byId };
}

const runtime = (provider: string, unavailableCode?: string): RuntimeMetadata =>
  ({
    provider,
    version: "1.0.0",
    displayName: provider,
    ...(unavailableCode ? { unavailableCode } : {}),
  }) as RuntimeMetadata;

test("an Agent that failed because its runtime was not installed starts once the runtime is reported", async () => {
  const f = fleet([
    { id: "a", provider: "droid", errorCode: "runtime_not_installed" },
    { id: "b", provider: "grok", errorCode: "runtime_not_installed" },
  ]);
  await recoverAgentsAfterInventory(f.ports, [runtime("droid")]);
  expect(f.started).toEqual(["a"]);
  expect(f.byId.get("a")?.errorCode).toBeUndefined();
  expect(f.byId.get("b")?.errorCode).toBe("runtime_not_installed");
});

test("a runtime reported as unusable starts nothing", async () => {
  const f = fleet([{ id: "a", provider: "droid", errorCode: "runtime_not_installed" }]);
  await recoverAgentsAfterInventory(f.ports, [runtime("droid", "version_unsupported")]);
  expect(f.started).toEqual([]);
  expect(f.byId.get("a")?.errorCode).toBe("runtime_not_installed");
});

test("a stopped, deleted or migrating Agent has its failure cleared but is not started", async () => {
  const f = fleet([
    { id: "stopped", provider: "droid", errorCode: "runtime_not_installed", stoppedAt: 1 },
    { id: "deleted", provider: "droid", errorCode: "runtime_not_installed", deletedAt: 1 },
    { id: "moving", provider: "droid", errorCode: "runtime_not_installed", migrating: true },
  ]);
  await recoverAgentsAfterInventory(f.ports, [runtime("droid")]);
  expect(f.started).toEqual([]);
});
