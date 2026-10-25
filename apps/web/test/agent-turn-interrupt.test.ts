import { expect, test } from "bun:test";
import {
  decodeAgentTurnInterruptIntent,
  encodeAgentTurnInterruptResult,
  type AgentTurnInterruptResult,
} from "@lrm/coforge-sdk/internal";
import { AgentTurnInterrupt } from "#src/server/agents/agent-turn-interrupt.server";
import type { AgentTurnInterruptResults } from "#src/server/agents/agent-turn-interrupt-results.server";
import { MemoryAgentTurnInterruptResults } from "./support/memory-agent-turn-interrupt-results";

const agent = {
  id: "agent-1",
  workspaceId: "workspace-1",
  ownerId: "user-1",
  computerId: "computer-1",
  visibility: "public",
  runtimeConfig: { runtime: "pi", model: "default", reasoning: "balanced" },
  state: {
    version: 1,
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "pi",
    epoch: 2,
    action: "start",
    phase: "completed",
    configRevision: "revision",
    launchId: "launch-1",
    controlSequence: 1,
    sessionSequence: 0,
  },
};

test("publishes a scoped interrupt and resolves only from its matching daemon result", async () => {
  let service!: AgentTurnInterrupt;
  const published: Uint8Array[] = [];
  service = new AgentTurnInterrupt(
    {
      get: async () => agent as never,
      memberRole: async () => "member",
    },
    {
      publish: async (_channel, bytes) => {
        published.push(bytes);
        const intent = decodeAgentTurnInterruptIntent(bytes);
        const result: AgentTurnInterruptResult = { ...intent, status: "interrupted" };
        queueMicrotask(() => service.receive(intent, result));
      },
    },
    { run: async (_agentId, callback) => callback() },
    { get: async () => true },
    { supports: async () => true },
    new MemoryAgentTurnInterruptResults(),
  );

  await expect(
    service.interrupt({
      userId: "user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      requestId: "interrupt-1",
    }),
  ).resolves.toBe("interrupted");
  expect(published).toHaveLength(1);
  expect(decodeAgentTurnInterruptIntent(published[0]!)).toMatchObject({
    requestId: "interrupt-1",
    launchId: "launch-1",
    epoch: 2,
  });
  expect(() =>
    encodeAgentTurnInterruptResult({
      ...decodeAgentTurnInterruptIntent(published[0]!),
      status: "interrupted",
    }),
  ).not.toThrow();
});

test("returns server-side availability outcomes without publishing", async () => {
  const service = new AgentTurnInterrupt(
    {
      get: async () => agent as never,
      memberRole: async () => "member",
    },
    { publish: async () => {} },
    { run: async (_agentId, callback) => callback() },
    { get: async () => false },
    { supports: async () => true },
    new MemoryAgentTurnInterruptResults(),
  );
  await expect(
    service.interrupt({
      userId: "user-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      requestId: "interrupt-2",
    }),
  ).resolves.toBe("offline");
});

function serviceOn(
  results: AgentTurnInterruptResults,
  onPublish: (intent: ReturnType<typeof decodeAgentTurnInterruptIntent>) => void,
  timeoutMs = 200,
) {
  return new AgentTurnInterrupt(
    { get: async () => agent as never, memberRole: async () => "member" },
    { publish: async (_channel, bytes) => onPublish(decodeAgentTurnInterruptIntent(bytes)) },
    { run: async (_agentId, callback) => callback() },
    { get: async () => true },
    { supports: async () => true },
    results,
    timeoutMs,
  );
}

const request = {
  userId: "user-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  requestId: "interrupt-3",
};

test("a result received by another instance reaches the instance that is waiting", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const other = serviceOn(results, () => {});
  const waiting = serviceOn(results, (intent) => {
    void other.receive(intent, { ...intent, status: "interrupted" });
  });
  await expect(waiting.interrupt(request)).resolves.toBe("interrupted");
});

test("a result stored before the wait begins is still found", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const other = serviceOn(results, () => {});
  const waiting = serviceOn(results, async (intent) => {
    await other.receive(intent, { ...intent, status: "interrupted" });
  });
  await expect(waiting.interrupt(request)).resolves.toBe("interrupted");
});

test("a result from a Computer that does not run the Agent is refused and does not block the real one", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const other = serviceOn(results, () => {});
  let refused: boolean | undefined;
  const waiting = serviceOn(results, async (intent) => {
    refused = await other.receive(
      { workspaceId: "workspace-1", computerId: "computer-2" },
      { ...intent, computerId: "computer-2", status: "not_running" },
    );
    await other.receive(intent, { ...intent, status: "interrupted" });
  });
  await expect(waiting.interrupt(request)).resolves.toBe("interrupted");
  expect(refused).toBe(false);
});

test("a result for another launch is skipped and the wait times out", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const other = serviceOn(results, () => {});
  const waiting = serviceOn(results, (intent) => {
    void other.receive(intent, { ...intent, launchId: "launch-0", status: "interrupted" });
  });
  await expect(waiting.interrupt(request)).resolves.toBe("failed");
});

test("Redis failing while waiting returns failed instead of throwing", async () => {
  const broken: AgentTurnInterruptResults = {
    put: async () => {},
    wait: async () => {
      throw new Error("redis down");
    },
  };
  await expect(serviceOn(broken, () => {}).interrupt(request)).resolves.toBe("failed");
});

test("a result for another Agent on the same request id does not block the real one", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const other = {
    ...agent,
    id: "agent-2",
    computerId: "computer-2",
  };
  const foreign = new AgentTurnInterrupt(
    { get: async () => other as never, memberRole: async () => "member" },
    { publish: async () => {} },
    { run: async (_agentId, callback) => callback() },
    { get: async () => true },
    { supports: async () => true },
    results,
  );
  const waiting = serviceOn(results, async (intent) => {
    await foreign.receive(
      { workspaceId: "workspace-1", computerId: "computer-2" },
      { ...intent, agentId: "agent-2", computerId: "computer-2", status: "not_running" },
    );
    await serviceOn(results, () => {}).receive(intent, { ...intent, status: "interrupted" });
  });
  await expect(waiting.interrupt(request)).resolves.toBe("interrupted");
});

test("a result for an earlier launch is refused and does not block the real one", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  let refused: boolean | undefined;
  const waiting = serviceOn(results, async (intent) => {
    refused = await serviceOn(results, () => {}).receive(intent, {
      ...intent,
      launchId: "launch-0",
      status: "not_running",
    });
    await serviceOn(results, () => {}).receive(intent, { ...intent, status: "interrupted" });
  });
  await expect(waiting.interrupt(request)).resolves.toBe("interrupted");
  expect(refused).toBe(false);
});
