import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlAgent,
  type AgentControlState,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";
import { WorkspaceAgentRecovery } from "#src/server/agents/agent-runtime-control.server";
import type { AgentRecord } from "#src/server/db/repositories/agent.repositories.server";
import { decodeAgentStartIntent } from "@lrm/coforge-sdk/internal";
import { pendingOpStore, pendingRuntimeConfig } from "./helpers/agent-control-store";

test("recover republishes a pending start unchanged, without superseding it", async () => {
  const { store, current } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: pendingRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 9,
      action: "start",
      phase: "starting",
      configRevision: agentControlRevision(pendingRuntimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
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
  expect(sent).toHaveLength(1);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "stuck-start",
    controlEpoch: 9,
  });
  // recover() never supersedes a current-scope operation: same requestId, same epoch, same
  // phase — only republished.
  expect(current().state).toMatchObject({ requestId: "stuck-start", epoch: 9, phase: "starting" });
});

const readyRecoveryIntent = {
  protocolMajor: 1,
  requestId: "ready-recovery",
  workspaceId: "w",
  computerId: "c",
  agentId: "a",
  provider: "pi" as const,
  model: "",
  reasoning: "",
};

function failedStartFixture(overrides: Partial<AgentControlState> = {}) {
  return pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: pendingRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "failed-start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 3,
      action: "start",
      phase: "failed",
      configRevision: agentControlRevision(pendingRuntimeConfig),
      controlSequence: 1,
      sessionSequence: 0,
      errorCode: "runtime_login_required",
      failedAtMs: Date.now(),
      ...overrides,
    },
  });
}

test("recover does not restart an Agent whose latest Start failed with a non-retryable error", async () => {
  const { store, current } = failedStartFixture();
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.recover(readyRecoveryIntent, "owner");
  expect(sent).toHaveLength(0);
  expect(current().state).toMatchObject({
    requestId: "failed-start",
    phase: "failed",
    errorCode: "runtime_login_required",
  });
});

test("recover retries a transient launch failure inside the retry window", async () => {
  const { store, current } = failedStartFixture({
    errorCode: "runtime_spawn_failed",
    failedAtMs: Date.now() - 15 * 60 * 1_000,
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.recover(readyRecoveryIntent, "owner");
  expect(sent).toHaveLength(1);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "ready-recovery",
    controlEpoch: 4,
  });
  expect(current().state).toMatchObject({ requestId: "ready-recovery", phase: "starting" });
});

test.each([
  ["inside the retry interval", 5 * 60 * 1_000],
  ["past the retry window", 25 * 60 * 60 * 1_000],
])("recover leaves a transient failure %s alone", async (_label, ageMs) => {
  const { store, current } = failedStartFixture({
    errorCode: "runtime_spawn_failed",
    failedAtMs: Date.now() - ageMs,
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.recover(readyRecoveryIntent, "owner");
  expect(sent).toHaveLength(0);
  expect(current().state).toMatchObject({ requestId: "failed-start", phase: "failed" });
});

test("recover restarts a pending operation whose scope is stale instead of republishing it", async () => {
  const { store, current } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: pendingRuntimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "stuck-start",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 9,
      action: "start",
      phase: "starting",
      configRevision: "superseded-config-revision",
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  await control.recover(readyRecoveryIntent, "owner");
  expect(sent).toHaveLength(1);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    requestId: "ready-recovery",
    controlEpoch: 10,
  });
  expect(current().state).toMatchObject({
    requestId: "ready-recovery",
    epoch: 10,
    phase: "starting",
  });
});

test("a launchId is minted once per operation and stays stable across a republish (recover)", async () => {
  const { store, current } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: pendingRuntimeConfig,
    state: null,
  });
  const sent: Uint8Array[] = [];
  // The daemon never answers, so the operation stays pending: `execute()`'s own single publish,
  // then two Daemon-ready `recover()` republishes of the SAME pending request. The launchId must
  // never change across any of them — no new epoch, no new mint.
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const view = await control.execute({
    userId: "owner",
    workspaceId: "w",
    agentId: "a",
    requestId: "start-1",
    action: "start",
  });
  expect(view.phase).toBe("pending");
  expect(sent).toHaveLength(1);
  const mintedLaunchId = decodeAgentStartIntent(sent[0]!).launchId;
  expect(mintedLaunchId).toBeTruthy();
  expect(current().state?.launchId).toBe(mintedLaunchId);

  const recoverIntent = {
    protocolMajor: 1,
    requestId: "recover-request",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "pi" as const,
    model: "",
    reasoning: "",
  };
  sent.length = 0;
  await control.recover(recoverIntent, "owner");
  await control.recover(recoverIntent, "owner");
  expect(sent).toHaveLength(2);
  for (const bytes of sent) expect(decodeAgentStartIntent(bytes).launchId).toBe(mintedLaunchId);
  expect(current().state?.launchId).toBe(mintedLaunchId);
  expect(current().state?.requestId).toBe("start-1");
});

// Staging incident (task #687): dorothy's pending Start sat at a current scope while a sibling
// Agent's unreadable runtimeConfig made every Daemon `ready` fail inside `agent_recovery`, so the
// Daemon held every control publication and no Agent on the Computer ever answered. The values
// below are dorothy's real staging rows; the sibling is qa457priv, whose stored config
// `{"runtime":42,"provider":"not-an-object"}` reads back as `undefined`.
const dorothyRuntimeConfig = {
  runtime: "cursor" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};
const dorothyWorkspaceId = "cc5c27ce-346f-4306-8614-db8f12669516";
const dorothyComputerId = "34c261c8-4611-4fba-8599-38e5bbd18203";
const dorothyAgentId = "74b2bb72-4435-4d3c-b86a-8965f2704f19";
const unreadableAgentId = "0544e278-00fa-41fb-911c-d303f9d3c010";

function agentRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: "agent",
    workspaceId: dorothyWorkspaceId,
    name: "agent",
    displayName: "Agent",
    createdAt: new Date("2026-11-05T18:12:21Z"),
    ownerId: "owner",
    computerId: dorothyComputerId,
    runtimeConfig: dorothyRuntimeConfig,
    stoppedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

test("one Agent's unreadable config does not stop ready recovery for the Computer's other Agents", async () => {
  const controlAgents = new Map<string, AgentControlAgent>([
    [
      dorothyAgentId,
      {
        id: dorothyAgentId,
        ownerId: "owner",
        workspaceId: dorothyWorkspaceId,
        computerId: dorothyComputerId,
        visibility: "public",
        runtimeConfig: dorothyRuntimeConfig,
        state: {
          version: 1,
          protocolMajor: 1,
          requestId: "fa5f8ae8-f467-4515-9b6c-badb42d89c98",
          workspaceId: dorothyWorkspaceId,
          computerId: dorothyComputerId,
          agentId: dorothyAgentId,
          provider: "cursor",
          epoch: 18,
          action: "start",
          phase: "starting",
          configRevision: "7169a5ade1aa0cb97b0c9c5a854136f379188c5813187c7d8dfeceb56ccaa65d",
          launchId: "5f7d4eee-3a5b-4563-9887-21168f4269d5",
          controlSequence: 0,
          sessionSequence: 0,
        },
      },
    ],
  ]);
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async (agentId) => {
      const agent = controlAgents.get(agentId);
      return agent ? structuredClone(agent) : undefined;
    },
    replace: async (before, state) => {
      const agent = controlAgents.get(before.id);
      if (!agent || JSON.stringify(before.state) !== JSON.stringify(agent.state)) return false;
      agent.state = structuredClone(state);
      return true;
    },
  };
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const records = new Map<string, AgentRecord>([
    [dorothyAgentId, agentRecord({ id: dorothyAgentId, name: "dorothy" })],
    [
      unreadableAgentId,
      agentRecord({ id: unreadableAgentId, name: "qa457priv", runtimeConfig: undefined }),
    ],
  ]);
  const recovery = new WorkspaceAgentRecovery(
    {
      getById: async (id) => records.get(id),
      listOwnedInWorkspace: async () => [],
      listInWorkspace: async () => [],
      listForComputer: async () => [...records.values()],
      listDeletedForComputer: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
    },
    { readAgentRecoveryContext: async () => ({ resumeMessages: [], unreadSummary: {} }) },
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { resendPending: async () => {} },
    undefined,
    control,
    store,
  );

  await recovery.recoverWorkspace(dorothyWorkspaceId, dorothyComputerId, []);

  expect(sent).toHaveLength(1);
  expect(decodeAgentStartIntent(sent[0]!)).toMatchObject({
    agentId: dorothyAgentId,
    requestId: "fa5f8ae8-f467-4515-9b6c-badb42d89c98",
    controlEpoch: 18,
    launchId: "5f7d4eee-3a5b-4563-9887-21168f4269d5",
  });
});

test("a Computer whose only Agent fails recovery still completes the Daemon's ready", async () => {
  const store: AgentControlStore = {
    memberRole: async () => "owner",
    get: async () => undefined,
    replace: async () => false,
  };
  const sent: Uint8Array[] = [];
  const control = new AgentControl(
    store,
    { publish: async (_channel, bytes) => void sent.push(bytes) },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
  const records = new Map<string, AgentRecord>([
    [
      unreadableAgentId,
      agentRecord({ id: unreadableAgentId, name: "qa457priv", runtimeConfig: undefined }),
    ],
  ]);
  const recovery = new WorkspaceAgentRecovery(
    {
      getById: async (id) => records.get(id),
      listOwnedInWorkspace: async () => [],
      listInWorkspace: async () => [],
      listForComputer: async () => [...records.values()],
      listDeletedForComputer: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
    },
    { readAgentRecoveryContext: async () => ({ resumeMessages: [], unreadSummary: {} }) },
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { resendPending: async () => {} },
    undefined,
    control,
    store,
  );

  // One bad Agent record must not fail `ready`: the Daemon would otherwise hold every later
  // control publication on this Computer forever.
  await recovery.recoverWorkspace(dorothyWorkspaceId, dorothyComputerId, []);

  expect(sent).toHaveLength(0);
});
