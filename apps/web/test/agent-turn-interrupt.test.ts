import { expect, test } from "bun:test";
import {
  decodeAgentTurnInterruptIntent,
  encodeAgentTurnInterruptResult,
  type AgentTurnInterruptResult,
} from "@lrm/coforge-sdk/internal";
import { AgentTurnInterrupt } from "#src/server/agents/agent-turn-interrupt.server";

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
