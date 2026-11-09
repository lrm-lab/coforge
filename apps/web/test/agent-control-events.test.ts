import { expect, test } from "bun:test";
import { AgentControlEvents } from "#src/server/agents/agent-control-events.server";
import {
  agentStatusChannel,
  agentStatusChannelFor,
} from "#src/features/agents/agent-status-channel";

function fixture() {
  const published: { channel: string; data: Record<string, unknown> }[] = [];
  const events = new AgentControlEvents({
    publishJson: async (channel: string, data: unknown) => {
      published.push({ channel, data: data as Record<string, unknown> });
    },
  });
  return { published, events };
}

const agent = { id: "agent-a", workspaceId: "workspace-a", visibility: "private" };

test("a phase-only control event reaches the shared status channel for every member", async () => {
  const { published, events } = fixture();
  events.publish(agent, {
    agentId: "agent-a",
    requestId: "req-1",
    action: "restart",
    phase: "pending",
  });
  await Bun.sleep(0);
  expect(published).toHaveLength(1);
  expect(published[0]!.channel).toBe(agentStatusChannel("workspace-a"));
  expect(published[0]!.data).toMatchObject({
    type: "agent.control.v1",
    agentId: "agent-a",
    requestId: "req-1",
    action: "restart",
    phase: "pending",
  });
  expect(published[0]!.data).not.toHaveProperty("errorCode");
  expect(published[0]!.data).not.toHaveProperty("detail");
});

test("an error-carrying control event stays on the private Agent's routed channel", async () => {
  const { published, events } = fixture();
  events.publish(agent, {
    agentId: "agent-a",
    requestId: "req-2",
    action: "start",
    phase: "failed",
    errorCode: "runtime_login_required",
    detail: "not signed in",
  });
  await Bun.sleep(0);
  expect(published).toHaveLength(1);
  expect(published[0]!.channel).toBe(agentStatusChannelFor("workspace-a", "agent-a", "private"));
  expect(published[0]!.channel).not.toBe(agentStatusChannel("workspace-a"));
  expect(published[0]!.data).toMatchObject({
    phase: "failed",
    errorCode: "runtime_login_required",
    detail: "not signed in",
  });
});

test("a public Agent's error event uses its routed channel, which is the shared one", async () => {
  const { published, events } = fixture();
  events.publish(
    { ...agent, visibility: "public" },
    {
      agentId: "agent-a",
      requestId: "req-3",
      action: "stop",
      phase: "failed",
      errorCode: "stop_failed",
    },
  );
  await Bun.sleep(0);
  expect(published[0]!.channel).toBe(agentStatusChannelFor("workspace-a", "agent-a", "public"));
  expect(published[0]!.channel).toBe(agentStatusChannel("workspace-a"));
});

test("a publish failure never throws into the control path", async () => {
  const events = new AgentControlEvents({
    publishJson: async () => {
      throw new Error("centrifugo down");
    },
  });
  expect(() =>
    events.publish(agent, {
      agentId: "agent-a",
      requestId: "req-4",
      action: "start",
      phase: "pending",
    }),
  ).not.toThrow();
  await Bun.sleep(0);
});
