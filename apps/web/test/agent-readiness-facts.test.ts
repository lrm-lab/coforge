import { expect, test } from "bun:test";
import {
  agentReadinessOf,
  readAgentReadinessInputs,
  type AgentReadinessPorts,
} from "#src/server/agents/agent-readiness-facts.server";
import type { AgentRuntimeSelection } from "#src/server/agents/agent-runtime-availability.server";

const NOW = Date.parse("2026-11-18T10:00:00.000Z");
const selection: AgentRuntimeSelection = {
  provider: "pi",
  model: "m",
  modelProvider: "p",
  reasoning: "",
  hasApiKey: false,
};

type Facts = Parameters<typeof agentReadinessOf>[1];

function ports(overrides: Partial<AgentReadinessPorts> = {}): AgentReadinessPorts {
  return {
    latestUpgrade: async () => undefined,
    runtimeRefusal: async () => null,
    ...overrides,
  };
}

function facts(overrides: Partial<Facts> = {}): Facts {
  return {
    nowMs: NOW,
    computerId: "computer-1",
    computerOnline: true,
    stopReason: null,
    failureReason: null,
    ...overrides,
  };
}

async function readiness(
  portOverrides: Partial<AgentReadinessPorts> = {},
  factOverrides: Partial<Facts> = {},
) {
  const f = facts(factOverrides);
  const reads = await readAgentReadinessInputs(ports(portOverrides), {
    computerId: f.computerId,
    selection,
  });
  return agentReadinessOf(reads, f);
}

test("an Agent with no Computer, or no word on whether it is online, is ready", async () => {
  expect(await readiness({}, { computerId: undefined })).toEqual({ state: "ready" });
  expect(await readiness({}, { computerOnline: undefined })).toEqual({ state: "ready" });
});

test("an online Computer with its runtime and no upgrade is ready", async () => {
  expect(await readiness()).toEqual({ state: "ready" });
});

test("an accepted upgrade inside its window reads as the Computer updating", async () => {
  expect(
    await readiness(
      {
        latestUpgrade: async () => ({
          requestId: "r",
          status: "accepted",
          expectedVersion: "1.0.0",
          expiresAt: new Date(NOW + 60_000).toISOString(),
        }),
      },
      { computerOnline: false },
    ),
  ).toMatchObject({ state: "computer_updating", also: ["computer_offline"] });
});

test("an upgrade that is not accepted does not make the Computer updating", async () => {
  expect(
    await readiness(
      {
        latestUpgrade: async () =>
          ({ requestId: "r", status: "failed", reason: "timeout" }) as never,
      },
      { computerOnline: false },
    ),
  ).toMatchObject({ state: "computer_offline" });
});

test("a runtime the Computer lacks reads as missing, but only while the Computer is online", async () => {
  const lacking = { runtimeRefusal: async () => "runtime_missing" as const };
  expect(await readiness(lacking)).toMatchObject({ state: "runtime_missing" });
  expect(await readiness(lacking, { computerOnline: false })).toMatchObject({
    state: "computer_offline",
    also: [],
  });
});

test("a failed read of the upgrade or of the runtime does not break the page", async () => {
  expect(
    await readiness({
      latestUpgrade: async () => {
        throw new Error("redis down");
      },
      runtimeRefusal: async () => {
        throw new Error("db down");
      },
    }),
  ).toEqual({ state: "ready" });
});

test("the stop and failure reasons come through", async () => {
  expect(await readiness({}, { stopReason: "runtime_login_required" })).toMatchObject({
    state: "runtime_login_required",
  });
  expect(await readiness({}, { failureReason: "agent_authorization_failed" })).toMatchObject({
    state: "launch_failed",
    detail: "agent_authorization_failed",
  });
});
