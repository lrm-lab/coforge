import { expect, test } from "bun:test";
import { startupDeadlineMs } from "@lrm/coforge-sdk/internal";
import {
  AgentControl,
  agentControlRevision,
  agentControlStateSchema,
  type AgentControlAgent,
  type AgentControlState,
} from "#src/server/agents/agent-control.server";
import { AgentControlDriver } from "#src/server/agents/agent-control-driver.server";
import { AgentControlPublisher } from "#src/server/agents/agent-control-publisher.server";
import { LocalAgentControlSignal } from "#src/server/agents/agent-control-signal.server";
import { pendingOpStore, pendingRuntimeConfig } from "./helpers/agent-control-store";

const NOW = 1_800_000_000_000;

const baseState: AgentControlState = {
  version: 1,
  protocolMajor: 1,
  requestId: "r1",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi",
  epoch: 3,
  action: "start",
  phase: "starting",
  configRevision: agentControlRevision(pendingRuntimeConfig),
  controlSequence: 0,
  sessionSequence: 0,
};

const agentWith = (state: AgentControlState | null): AgentControlAgent => ({
  id: "a",
  ownerId: "owner",
  visibility: "public",
  workspaceId: "w",
  computerId: "c",
  runtimeConfig: pendingRuntimeConfig,
  state,
});

function controlOver(agent: AgentControlAgent) {
  const fixture = pendingOpStore(agent);
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    fixture.store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0, now: () => NOW },
  );
  return { ...fixture, control, sent };
}

test("the persisted control state accepts the startup deadline fields", () => {
  const parsed = agentControlStateSchema.parse({
    ...baseState,
    startedAtMs: NOW,
    deadlineAtMs: NOW + 300_000,
    stopSentAtMs: NOW + 400_000,
  });
  expect(parsed).toMatchObject({ startedAtMs: NOW, deadlineAtMs: NOW + 300_000 });
  expect(parsed.stopSentAtMs).toBe(NOW + 400_000);
});

test("a Start records when it began and the deadline for its provider", async () => {
  const { control, current } = controlOver(agentWith(null));
  await control.publishStart(
    {
      protocolMajor: 1,
      requestId: "fresh",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(current().state).toMatchObject({
    phase: "starting",
    startedAtMs: NOW,
    deadlineAtMs: NOW + startupDeadlineMs("pi"),
  });
});

test("a slow provider's deadline is twenty-one minutes", async () => {
  const slowConfig = { ...pendingRuntimeConfig, runtime: "opencode" as const };
  const agent = { ...agentWith(null), runtimeConfig: slowConfig };
  const { control, current } = controlOver(agent);
  await control.publishStart(
    {
      protocolMajor: 1,
      requestId: "slow",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "opencode",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(current().state?.deadlineAtMs).toBe(NOW + 1_260_000);
});

test("republishing the same pending Start keeps its original deadline", async () => {
  const original = { ...baseState, startedAtMs: NOW - 60_000, deadlineAtMs: NOW + 240_000 };
  const { control, current } = controlOver(agentWith(original));
  await control.recover(
    {
      protocolMajor: 1,
      requestId: "ready-recovery",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      model: "",
      reasoning: "",
    },
    "owner",
  );
  expect(current().state).toMatchObject({
    requestId: "r1",
    startedAtMs: NOW - 60_000,
    deadlineAtMs: NOW + 240_000,
  });
});

test("a Restart enters its Start step with a fresh deadline once the stop is done", async () => {
  const stopped: AgentControlState = {
    ...baseState,
    action: "restart",
    phase: "stopped",
    requestId: "restart-1",
  };
  const { store, current } = pendingOpStore(agentWith(stopped));
  const publisher = new AgentControlPublisher(store, { publish: async () => {} }, () => NOW);
  const driver = new AgentControlDriver(
    store,
    publisher,
    new LocalAgentControlSignal(),
    { timeoutMs: 0, fallbackMs: 0 },
    () => NOW,
  );
  await driver.advance("a", "restart-1");
  expect(current().state).toMatchObject({
    phase: "starting",
    startedAtMs: NOW,
    deadlineAtMs: NOW + startupDeadlineMs("pi"),
  });
});
