import { expect, test } from "bun:test";
import { decodeAgentContextUsage, RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { AgentObservationPublisher } from "#src/connection/agent-observation-publisher";

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
