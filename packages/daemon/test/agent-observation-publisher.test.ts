import { expect, test } from "bun:test";
import {
  AGENT_CONTEXT_USAGE_METHOD,
  AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  AGENT_SERVICE_TIER_METHOD,
  decodeAgentContextUsage,
  decodeAgentServiceTier,
  RUNTIME_PROVIDER,
} from "@lrm/coforge-sdk/internal";
import { AgentObservationPublisher } from "#src/connection/agent-observation-publisher";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";

function contextUsage(agentId: string, usedTokens: number) {
  return {
    protocolMajor: 1,
    requestId: `report-${usedTokens}`,
    workspaceId: "w",
    computerId: "c",
    agentId,
    provider: RUNTIME_PROVIDER.ANTIGRAVITY,
    launchId: "launch",
    sessionId: "native-session",
    usedTokens,
    windowTokens: 1_048_576,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon",
    clientSeq: usedTokens,
  };
}

function harness() {
  const calls: Array<{ agentId: string; usedTokens: number; settle: () => void }> = [];
  const client = {
    rpc(_method: string, data: Uint8Array) {
      const { agentId, usedTokens } = decodeAgentContextUsage(data);
      const done = Promise.withResolvers<unknown>();
      calls.push({ agentId, usedTokens, settle: () => done.reject(new Error("timeout")) });
      return done.promise;
    },
  };
  const publisher = new AgentObservationPublisher({
    contextUsage: "agent:context_usage",
    serviceTier: "agent:service_tier",
    contextViewAvailability: "agent:context_view_availability",
  });
  return { calls, client: client as never, publisher };
}

test("a burst of context readings keeps one RPC per Agent on the wire and then sends the newest", async () => {
  const h = harness();
  for (let used = 1; used <= 30; used++)
    h.publisher.sendContextUsage(contextUsage("agent-a", used), h.client);
  h.publisher.sendContextUsage(contextUsage("agent-b", 7), h.client);

  expect(h.calls.map((call) => [call.agentId, call.usedTokens])).toEqual([
    ["agent-a", 1],
    ["agent-b", 7],
  ]);

  h.calls[0]!.settle();
  await Bun.sleep(0);
  expect(h.calls.map((call) => [call.agentId, call.usedTokens])).toEqual([
    ["agent-a", 1],
    ["agent-b", 7],
    ["agent-a", 30],
  ]);

  h.calls[2]!.settle();
  await Bun.sleep(0);
  expect(h.calls).toHaveLength(3);

  h.publisher.sendContextUsage(contextUsage("agent-a", 31), h.client);
  expect(h.calls.at(-1)).toMatchObject({ agentId: "agent-a", usedTokens: 31 });
});

function publisher() {
  return new AgentObservationPublisher({
    contextUsage: AGENT_CONTEXT_USAGE_METHOD,
    serviceTier: AGENT_SERVICE_TIER_METHOD,
    contextViewAvailability: AGENT_CONTEXT_VIEW_AVAILABILITY_METHOD,
  });
}

function fakeClient() {
  const sent: Array<{ method: string; data: Uint8Array }> = [];
  const client: CentrifugeWorkspaceClient = {
    on: () => {},
    connect: () => {},
    disconnect: () => {},
    rpc: async (method, data) => {
      sent.push({ method, data });
      return new Uint8Array();
    },
  };
  return { client, sent };
}

test("contextUsage and serviceTier buffered while disconnected for the same Agent both flush on reconnect", () => {
  const observations = publisher();
  observations.sendContextUsage({
    protocolMajor: 1,
    requestId: "req-1",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "session-1",
    usedTokens: 1_200,
    windowTokens: 200_000,
    observedAtMs: 100,
    daemonInstanceId: "daemon-1",
    clientSeq: 1,
  });
  // A newer contextUsage for the same Agent replaces the older contextUsage, while serviceTier for
  // that same Agent keeps its own slot instead of evicting contextUsage.
  observations.sendContextUsage({
    protocolMajor: 1,
    requestId: "req-2",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "session-1",
    usedTokens: 2_400,
    windowTokens: 200_000,
    observedAtMs: 200,
    daemonInstanceId: "daemon-1",
    clientSeq: 2,
  });
  observations.sendServiceTier({
    protocolMajor: 1,
    requestId: "req-3",
    workspaceId: "workspace-a",
    computerId: "computer-a",
    agentId: "agent-a",
    provider: "claude-code",
    launchId: "launch-1",
    sessionId: "session-1",
    requested: true,
    observed: "on",
    observedAtMs: 300,
    daemonInstanceId: "daemon-1",
    clientSeq: 3,
  });

  const { client, sent } = fakeClient();
  observations.flush(client);

  expect(sent.map((entry) => entry.method)).toEqual([
    AGENT_CONTEXT_USAGE_METHOD,
    AGENT_SERVICE_TIER_METHOD,
  ]);
  expect(decodeAgentContextUsage(sent[0]!.data).usedTokens).toBe(2_400);
  expect(decodeAgentServiceTier(sent[1]!.data).observed).toBe("on");
});
