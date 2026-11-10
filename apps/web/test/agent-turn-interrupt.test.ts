import { expect, test } from "bun:test";
import {
  decodeAgentTurnInterruptIntent,
  type AgentTurnInterruptIntent,
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

const caller = { userId: "user-1", workspaceId: "workspace-1", agentId: "agent-1" };

function serviceOn(
  results: AgentTurnInterruptResults,
  options: {
    onPublish?: (intent: AgentTurnInterruptIntent) => void | Promise<void>;
    agents?: Record<string, unknown>;
    role?: () => string | null;
    online?: boolean;
    supported?: boolean;
  } = {},
) {
  const agents = options.agents ?? { [agent.id]: agent };
  return new AgentTurnInterrupt(
    {
      get: async (id) => (agents[id] ?? null) as never,
      memberRole: async () => (options.role ? options.role() : "member") as never,
    },
    {
      publish: async (_channel, bytes) => {
        await options.onPublish?.(decodeAgentTurnInterruptIntent(bytes));
      },
    },
    { run: async (_agentId, callback) => callback() },
    { get: async () => options.online ?? true },
    { supports: async () => options.supported ?? true },
    results,
  );
}

/** Starts an interrupt and returns the intent the Computer was sent, which names the request. */
async function started(service: AgentTurnInterrupt, published: AgentTurnInterruptIntent[]) {
  const start = await service.start(caller);
  if (start.status !== "started") throw new Error(`start was refused: ${start.reason}`);
  expect(published).toHaveLength(1);
  expect(published[0]!.requestId).toBe(start.requestId);
  return published[0]!;
}

test("start publishes the scoped intent and returns its request id without waiting for the Computer", async () => {
  const published: AgentTurnInterruptIntent[] = [];
  const service = serviceOn(new MemoryAgentTurnInterruptResults(), {
    onPublish: (intent) => void published.push(intent),
  });
  const intent = await started(service, published);
  expect(intent).toMatchObject({
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    launchId: "launch-1",
    epoch: 2,
  });
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "pending",
  });
});

test("every start asks with a request id of its own", async () => {
  const published: AgentTurnInterruptIntent[] = [];
  const service = serviceOn(new MemoryAgentTurnInterruptResults(), {
    onPublish: (intent) => void published.push(intent),
  });
  await service.start(caller);
  await service.start(caller);
  expect(new Set(published.map((intent) => intent.requestId)).size).toBe(2);
});

test("read settles on the Computer's result once it has been received", async () => {
  const published: AgentTurnInterruptIntent[] = [];
  const service = serviceOn(new MemoryAgentTurnInterruptResults(), {
    onPublish: (intent) => void published.push(intent),
  });
  const intent = await started(service, published);
  await service.receive(intent, { ...intent, status: "restarted" });
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "restarted",
  });
  // The answer is left to expire, so a page that lost the reply can ask again.
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "restarted",
  });
});

test("a result received by another instance is read by the one that started the request", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const published: AgentTurnInterruptIntent[] = [];
  const starting = serviceOn(results, { onPublish: (intent) => void published.push(intent) });
  const receiving = serviceOn(results);
  const intent = await started(starting, published);
  await receiving.receive(intent, { ...intent, status: "interrupted" });
  await expect(starting.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "interrupted",
  });
});

test("a result that arrives before the first read is still found", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const receiving = serviceOn(results);
  const service = serviceOn(results, {
    onPublish: async (intent) => {
      await receiving.receive(intent, { ...intent, status: "interrupted" });
    },
  });
  const start = await service.start(caller);
  if (start.status !== "started") throw new Error("expected the start to go out");
  await expect(service.read({ ...caller, requestId: start.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "interrupted",
  });
});

test("start refuses without publishing when the Computer is offline or too old, or nothing runs", async () => {
  const published: AgentTurnInterruptIntent[] = [];
  const onPublish = (intent: AgentTurnInterruptIntent) => void published.push(intent);
  const results = new MemoryAgentTurnInterruptResults();
  await expect(serviceOn(results, { onPublish, online: false }).start(caller)).resolves.toEqual({
    status: "refused",
    reason: "offline",
  });
  await expect(serviceOn(results, { onPublish, supported: false }).start(caller)).resolves.toEqual({
    status: "refused",
    reason: "needs_upgrade",
  });
  const stopped = { ...agent, state: { ...agent.state, action: "stop" } };
  await expect(
    serviceOn(results, { onPublish, agents: { [agent.id]: stopped } }).start(caller),
  ).resolves.toEqual({ status: "refused", reason: "not_running" });
  expect(published).toHaveLength(0);
});

test("start refuses as offline when the intent cannot be published", async () => {
  const service = serviceOn(new MemoryAgentTurnInterruptResults(), {
    onPublish: () => {
      throw new Error("centrifugo down");
    },
  });
  await expect(service.start(caller)).resolves.toEqual({ status: "refused", reason: "offline" });
});

test("start rejects a caller who may not control the Agent, and publishes nothing", async () => {
  const published: AgentTurnInterruptIntent[] = [];
  const onPublish = (intent: AgentTurnInterruptIntent) => void published.push(intent);
  const results = new MemoryAgentTurnInterruptResults();
  await expect(serviceOn(results, { onPublish, role: () => null }).start(caller)).rejects.toThrow(
    "not authorized",
  );
  await expect(
    serviceOn(results, { onPublish }).start({ ...caller, workspaceId: "workspace-2" }),
  ).rejects.toThrow("not authorized");
  await expect(
    serviceOn(results, { onPublish }).start({ ...caller, agentId: "agent-missing" }),
  ).rejects.toThrow("not authorized");
  expect(published).toHaveLength(0);
});

test("read checks the caller's access again and returns nothing once it is gone", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const published: AgentTurnInterruptIntent[] = [];
  let role: string | null = "member";
  const service = serviceOn(results, {
    onPublish: (intent) => void published.push(intent),
    role: () => role,
  });
  const intent = await started(service, published);
  await service.receive(intent, { ...intent, status: "interrupted" });
  role = null;
  await expect(service.read({ ...caller, requestId: intent.requestId })).rejects.toThrow(
    "not authorized",
  );
});

test("a request id reads nothing across Workspaces or Agents", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const published: AgentTurnInterruptIntent[] = [];
  const other = { ...agent, id: "agent-2" };
  const elsewhere = { ...agent, id: "agent-3", workspaceId: "workspace-2" };
  const service = serviceOn(results, {
    agents: { [agent.id]: agent, [other.id]: other, [elsewhere.id]: elsewhere },
    onPublish: (intent) => void published.push(intent),
  });
  const intent = await started(service, published);
  await service.receive(intent, { ...intent, status: "interrupted" });

  // Another Agent of the same Workspace the caller may control: the request is not its own.
  await expect(
    service.read({ ...caller, agentId: "agent-2", requestId: intent.requestId }),
  ).resolves.toEqual({ status: "pending" });
  // An Agent of another Workspace is not the caller's to read at all.
  await expect(
    service.read({ ...caller, agentId: "agent-3", requestId: intent.requestId }),
  ).rejects.toThrow("not authorized");
  await expect(
    service.read({ ...caller, workspaceId: "workspace-2", requestId: intent.requestId }),
  ).rejects.toThrow("not authorized");
});

test("a result from a Computer that does not run the Agent is refused and does not block the real one", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const published: AgentTurnInterruptIntent[] = [];
  const service = serviceOn(results, { onPublish: (intent) => void published.push(intent) });
  const intent = await started(service, published);
  await expect(
    service.receive(
      { workspaceId: "workspace-1", computerId: "computer-2" },
      { ...intent, computerId: "computer-2", status: "not_running" },
    ),
  ).resolves.toBe(false);
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "pending",
  });
  await service.receive(intent, { ...intent, status: "interrupted" });
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "interrupted",
  });
});

test("a result for an earlier launch is refused and does not block the real one", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const published: AgentTurnInterruptIntent[] = [];
  const service = serviceOn(results, { onPublish: (intent) => void published.push(intent) });
  const intent = await started(service, published);
  await expect(
    service.receive(intent, { ...intent, launchId: "launch-0", status: "not_running" }),
  ).resolves.toBe(false);
  await service.receive(intent, { ...intent, status: "interrupted" });
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "interrupted",
  });
});

test("a result for another Agent on the same request id does not block the real one", async () => {
  const results = new MemoryAgentTurnInterruptResults();
  const published: AgentTurnInterruptIntent[] = [];
  const other = { ...agent, id: "agent-2", computerId: "computer-2" };
  const service = serviceOn(results, {
    agents: { [agent.id]: agent, [other.id]: other },
    onPublish: (intent) => void published.push(intent),
  });
  const intent = await started(service, published);
  await service.receive(
    { workspaceId: "workspace-1", computerId: "computer-2" },
    { ...intent, agentId: "agent-2", computerId: "computer-2", status: "not_running" },
  );
  await service.receive(intent, { ...intent, status: "interrupted" });
  await expect(service.read({ ...caller, requestId: intent.requestId })).resolves.toEqual({
    status: "settled",
    outcome: "interrupted",
  });
});
