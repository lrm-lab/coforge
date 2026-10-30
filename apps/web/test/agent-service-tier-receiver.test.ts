import { expect, test } from "bun:test";
import { encodeAgentServiceTier, type AgentServiceTier } from "@lrm/coforge-sdk/internal";
import type { AgentControlAgent, AgentControlState } from "#src/server/agents/agent-control.server";
import { createAgentServiceTierMethod } from "#src/server/centrifugo/agent-service-tier-receiver.server";

function fixture() {
  const config = {
    runtime: "claude-code" as const,
    provider: { kind: "default" as const },
    model: "",
    modelProvider: "",
    reasoning: "",
  };
  const state: AgentControlState = {
    version: 1,
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "claude-code",
    epoch: 1,
    action: "start",
    phase: "starting",
    configRevision: "",
    launchId: "launch-1",
    identity: { sessionId: "native-session", state: "resumable" },
    controlSequence: 0,
    sessionSequence: 1,
  };
  const agent: AgentControlAgent = {
    id: "agent",
    workspaceId: "workspace",
    computerId: "computer",
    ownerId: "owner",
    visibility: "public",
    runtimeConfig: config,
    state,
  };
  const message: AgentServiceTier = {
    protocolMajor: 1,
    requestId: "service-tier-1",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "native-session",
    requested: true,
    observed: "on",
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon-current",
    clientSeq: 1,
  };
  return { agent, message };
}

function snapshotWith(message: AgentServiceTier) {
  return {
    protocolMajor: 1 as const,
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    revision: 2,
    activityKind: "online" as const,
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: 1,
    fastMode: { requested: true, observed: message.observed, observedAtMs: message.observedAtMs },
  };
}

test("accepts a matching launch, writes the display snapshot, and publishes it", async () => {
  const { agent, message } = fixture();
  const puts: AgentServiceTier[] = [];
  const published: Array<{ channel: string; data: unknown }> = [];
  const snapshot = snapshotWith(message);
  const method = createAgentServiceTierMethod(
    { get: async (id) => (id === agent.id ? structuredClone(agent) : undefined) },
    {
      putServiceTier: async (input) => {
        puts.push(input);
        return snapshot;
      },
    },
    {
      publishJson: async (channel, data) => {
        published.push({ channel, data });
      },
    },
    async () => "public",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentServiceTier(message), { principal })).toBeInstanceOf(Uint8Array);

  expect(puts).toEqual([message]);
  expect(published).toEqual([
    { channel: "agentstatus:workspace", data: { type: "agent:display", ...snapshot } },
  ]);
});

test("rejects a foreign transport principal and a malformed payload", async () => {
  const { message } = fixture();
  const method = createAgentServiceTierMethod(
    { get: async () => undefined },
    undefined,
    undefined,
    async () => "public",
  );
  const bytes = encodeAgentServiceTier(message);

  expect(
    await method(bytes, {
      principal: {
        userId: "owner",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "agent",
      },
    }),
  ).toMatchObject({ code: 403 });
  expect(
    await method(bytes, {
      principal: { userId: "owner", workspaceId: "other", computerId: "computer" },
    }),
  ).toMatchObject({ code: 403 });
  expect(
    await method(new Uint8Array([1, 2, 3]), {
      principal: { userId: "owner", workspaceId: "workspace", computerId: "computer" },
    }),
  ).toMatchObject({ code: 400 });
});

test("is an idempotent no-op for a stale launch, unknown Agent, or foreign scope, never calling the display", async () => {
  const { agent, message } = fixture();
  let calls = 0;
  const putServiceTier = async () => {
    calls++;
    return undefined;
  };
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };
  const bytes = encodeAgentServiceTier(message);

  const staleLaunch = createAgentServiceTierMethod(
    {
      get: async () =>
        structuredClone({ ...agent, state: { ...agent.state!, launchId: "launch-2" } }),
    },
    { putServiceTier },
    undefined,
    async () => "public",
  );
  expect(await staleLaunch(bytes, { principal })).toBeInstanceOf(Uint8Array);

  const unknownAgent = createAgentServiceTierMethod(
    { get: async () => undefined },
    { putServiceTier },
    undefined,
    async () => "public",
  );
  expect(await unknownAgent(bytes, { principal })).toBeInstanceOf(Uint8Array);

  const foreignComputer = createAgentServiceTierMethod(
    { get: async () => structuredClone({ ...agent, computerId: "other-computer" }) },
    { putServiceTier },
    undefined,
    async () => "public",
  );
  expect(await foreignComputer(bytes, { principal })).toBeInstanceOf(Uint8Array);

  const foreignProvider = createAgentServiceTierMethod(
    {
      get: async () =>
        structuredClone({
          ...agent,
          runtimeConfig: { ...agent.runtimeConfig, runtime: "kiro" as const },
        }),
    },
    { putServiceTier },
    undefined,
    async () => "public",
  );
  expect(await foreignProvider(bytes, { principal })).toBeInstanceOf(Uint8Array);

  const noControlState = createAgentServiceTierMethod(
    { get: async () => structuredClone({ ...agent, state: null }) },
    { putServiceTier },
    undefined,
    async () => "public",
  );
  expect(await noControlState(bytes, { principal })).toBeInstanceOf(Uint8Array);

  expect(calls).toBe(0);
});

// The reading is a display fact like any other `agent:display` push, so it follows the
// same per-Agent-or-shared status channel split the sweep and publish proxy use.
test("routes the display snapshot to a private Agent's per-Agent status channel", async () => {
  const { agent, message } = fixture();
  const published: Array<{ channel: string; data: unknown }> = [];
  const snapshot = snapshotWith(message);
  const method = createAgentServiceTierMethod(
    { get: async (id) => (id === agent.id ? structuredClone(agent) : undefined) },
    { putServiceTier: async () => snapshot },
    { publishJson: async (channel, data) => void published.push({ channel, data }) },
    async () => "private",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentServiceTier(message), { principal })).toBeInstanceOf(Uint8Array);

  expect(published).toEqual([
    { channel: "agentstatus:workspace:agent", data: { type: "agent:display", ...snapshot } },
  ]);
});

// `agentVisibility` is a required dependency (no `?`): a lookup that cannot answer the
// visibility question must not silently fall back to publishing on the shared channel.
test("skips the display publish when the visibility lookup finds nothing to route by (fail closed)", async () => {
  const { agent, message } = fixture();
  const published: Array<{ channel: string }> = [];
  const method = createAgentServiceTierMethod(
    { get: async () => structuredClone(agent) },
    { putServiceTier: async () => snapshotWith(message) },
    { publishJson: async (channel) => void published.push({ channel }) },
    async () => undefined,
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentServiceTier(message), { principal })).toBeInstanceOf(Uint8Array);
  expect(published).toHaveLength(0);
});

test("propagates a genuine store failure as a logged 403, not a silent no-op", async () => {
  const { message } = fixture();
  const method = createAgentServiceTierMethod(
    {
      get: async () => {
        throw new Error("database unavailable");
      },
    },
    undefined,
    undefined,
    async () => "public",
  );
  const principal = { userId: "owner", workspaceId: "workspace", computerId: "computer" };

  expect(await method(encodeAgentServiceTier(message), { principal })).toMatchObject({
    code: 403,
  });
});
