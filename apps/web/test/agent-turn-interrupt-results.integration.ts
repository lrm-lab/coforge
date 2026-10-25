import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import { RedisAgentTurnInterruptResults } from "#src/server/agents/agent-turn-interrupt-results.server";

const url = Bun.env.AGENT_TURN_INTERRUPT_TEST_REDIS_URL;
if (!url) throw new Error("AGENT_TURN_INTERRUPT_TEST_REDIS_URL must target a scratch Redis");

const clients: RedisClient[] = [];
function instance() {
  const redis = new RedisClient(url!);
  const subscriber = new RedisClient(url!);
  clients.push(redis, subscriber);
  return new RedisAgentTurnInterruptResults(redis, subscriber);
}
afterAll(() => {
  for (const client of clients) client.close();
});

function result(requestId: string, overrides: Partial<AgentTurnInterruptResult> = {}) {
  return {
    protocolMajor: 1,
    requestId,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    provider: "pi",
    epoch: 1,
    launchId: "launch-1",
    status: "interrupted",
    ...overrides,
  } as AgentTurnInterruptResult;
}
const anyResult = () => true;

test("a result stored by another instance reaches the one waiting", async () => {
  const waiting = instance();
  const receiving = instance();
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `cross-${crypto.randomUUID()}`,
  };
  const waited = waiting.wait(scope, 5_000, anyResult);
  await Bun.sleep(100);
  await receiving.put(scope, result(scope.requestId));
  expect(await waited).toMatchObject({ requestId: scope.requestId, status: "interrupted" });
});

test("a result stored before the wait begins is found by the read after subscribing", async () => {
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `early-${crypto.randomUUID()}`,
  };
  await instance().put(scope, result(scope.requestId));
  const started = performance.now();
  expect(await instance().wait(scope, 5_000, anyResult)).toMatchObject({ status: "interrupted" });
  expect(performance.now() - started).toBeLessThan(2_000);
});

test("the first result for a request wins", async () => {
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `nx-${crypto.randomUUID()}`,
  };
  const store = instance();
  await store.put(scope, result(scope.requestId, { status: "interrupted" }));
  await store.put(scope, result(scope.requestId, { status: "not_running" }));
  expect(await store.wait(scope, 5_000, anyResult)).toMatchObject({ status: "interrupted" });
});

test("a result the waiter refuses is skipped and the wait times out", async () => {
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `refused-${crypto.randomUUID()}`,
  };
  const store = instance();
  await store.put(scope, result(scope.requestId, { launchId: "launch-0" }));
  expect(await store.wait(scope, 300, (r) => r.launchId === "launch-1")).toBe("timeout");
});

test("results are scoped to the Workspace", async () => {
  const requestId = `scoped-${crypto.randomUUID()}`;
  const store = instance();
  await store.put({ workspaceId: "workspace-2", agentId: "agent-1", requestId }, result(requestId));
  expect(
    await store.wait({ workspaceId: "workspace-1", agentId: "agent-1", requestId }, 300, anyResult),
  ).toBe("timeout");
});

test("a waiter is notified after the subscriber's connection was lost and restored", async () => {
  const redis = new RedisClient(url!);
  const subscriber = new RedisClient(url!, { maxRetries: 4_294_967_295 });
  clients.push(redis, subscriber);
  const store = new RedisAgentTurnInterruptResults(redis, subscriber);
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `reconnect-${crypto.randomUUID()}`,
  };
  const waited = store.wait(scope, 10_000, anyResult);
  await Bun.sleep(100);
  // Closes the subscriber's connection on the server side; the client reconnects by itself.
  await redis.send("CLIENT", ["KILL", "TYPE", "pubsub"]);
  await Bun.sleep(1_000);
  await store.put(scope, result(scope.requestId));
  expect(await waited).toMatchObject({ status: "interrupted" });
});

test("a result naming another Agent cannot take the key of a request", async () => {
  const requestId = `agent-${crypto.randomUUID()}`;
  const store = instance();
  await store.put(
    { workspaceId: "workspace-1", agentId: "agent-2", requestId },
    result(requestId, { agentId: "agent-2" }),
  );
  await store.put({ workspaceId: "workspace-1", agentId: "agent-1", requestId }, result(requestId));
  expect(
    await store.wait(
      { workspaceId: "workspace-1", agentId: "agent-1", requestId },
      2_000,
      anyResult,
    ),
  ).toMatchObject({ agentId: "agent-1", status: "interrupted" });
});

test("a wait ends at its timeout even when the subscription never completes", async () => {
  const store = new RedisAgentTurnInterruptResults(new RedisClient(url!), {
    subscribe: () => new Promise(() => {}),
    send: async () => {},
    onconnect: null,
  });
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `hung-${crypto.randomUUID()}`,
  };
  expect(await store.wait(scope, 300, anyResult)).toBe("timeout");
});

test("a result is consumed by the wait that takes it", async () => {
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `once-${crypto.randomUUID()}`,
  };
  const store = instance();
  await store.put(scope, result(scope.requestId));
  expect(await store.wait(scope, 2_000, anyResult)).toMatchObject({ status: "interrupted" });
  await Bun.sleep(100);
  expect(await store.wait(scope, 300, anyResult)).toBe("timeout");
});

test("a wait ends at its timeout even when reading the key stalls", async () => {
  const store = new RedisAgentTurnInterruptResults(
    {
      get: () => new Promise(() => {}),
      set: async () => {},
      del: async () => {},
      publish: async () => {},
    },
    { subscribe: async () => {}, send: async () => {}, onconnect: null },
  );
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `stalled-${crypto.randomUUID()}`,
  };
  expect(await store.wait(scope, 300, anyResult)).toBe("timeout");
});
