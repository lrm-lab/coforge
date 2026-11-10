import { afterAll, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { AgentTurnInterruptResult } from "@lrm/coforge-sdk/internal";
import {
  AGENT_TURN_INTERRUPT_RESULT_TTL_SECONDS,
  RedisAgentTurnInterruptResults,
} from "#src/server/agents/agent-turn-interrupt-results.server";

const url = Bun.env.AGENT_TURN_INTERRUPT_TEST_REDIS_URL;
if (!url) throw new Error("AGENT_TURN_INTERRUPT_TEST_REDIS_URL must target a scratch Redis");

const clients: RedisClient[] = [];
function client() {
  const redis = new RedisClient(url!);
  clients.push(redis);
  return redis;
}
function instance() {
  return new RedisAgentTurnInterruptResults(client());
}
afterAll(() => {
  for (const redis of clients) redis.close();
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

test("a result stored by one instance is read by another", async () => {
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `cross-${crypto.randomUUID()}`,
  };
  expect(await instance().read(scope)).toBeUndefined();
  await instance().put(scope, result(scope.requestId));
  expect(await instance().read(scope)).toMatchObject({
    requestId: scope.requestId,
    status: "interrupted",
  });
});

test("a result stays readable for a page that lost the reply, and expires", async () => {
  const scope = {
    workspaceId: "workspace-1",
    agentId: "agent-1",
    requestId: `again-${crypto.randomUUID()}`,
  };
  const store = instance();
  await store.put(scope, result(scope.requestId));
  expect(await store.read(scope)).toMatchObject({ status: "interrupted" });
  expect(await store.read(scope)).toMatchObject({ status: "interrupted" });
  const redis = client();
  const [key] = (await redis.send("KEYS", [`*${scope.requestId}`])) as string[];
  const ttl = Number(await redis.send("TTL", [key!]));
  expect(ttl).toBeGreaterThan(0);
  expect(ttl).toBeLessThanOrEqual(AGENT_TURN_INTERRUPT_RESULT_TTL_SECONDS);
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
  expect(await store.read(scope)).toMatchObject({ status: "interrupted" });
});

test("results are scoped to the Workspace", async () => {
  const requestId = `scoped-${crypto.randomUUID()}`;
  const store = instance();
  await store.put({ workspaceId: "workspace-2", agentId: "agent-1", requestId }, result(requestId));
  expect(
    await store.read({ workspaceId: "workspace-1", agentId: "agent-1", requestId }),
  ).toBeUndefined();
});

test("a result naming another Agent cannot take the key of a request", async () => {
  const requestId = `agent-${crypto.randomUUID()}`;
  const store = instance();
  await store.put(
    { workspaceId: "workspace-1", agentId: "agent-2", requestId },
    result(requestId, { agentId: "agent-2" }),
  );
  expect(
    await store.read({ workspaceId: "workspace-1", agentId: "agent-1", requestId }),
  ).toBeUndefined();
  await store.put({ workspaceId: "workspace-1", agentId: "agent-1", requestId }, result(requestId));
  expect(
    await store.read({ workspaceId: "workspace-1", agentId: "agent-1", requestId }),
  ).toMatchObject({ agentId: "agent-1", status: "interrupted" });
});
