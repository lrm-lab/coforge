import { expect, test } from "bun:test";
import {
  AgentControl,
  agentControlRevision,
  type AgentControlStore,
} from "#src/server/agents/agent-control.server";
import { pendingOpStore } from "./helpers/agent-control-store";

const runtimeConfig = {
  runtime: "pi" as const,
  provider: { kind: "default" as const },
  model: "",
  modelProvider: "",
  reasoning: "",
};

function captureInfo() {
  const events: Array<Record<string, unknown>> = [];
  const original = console.info;
  console.info = (...args: unknown[]) => events.push(JSON.parse(args[0] as string));
  return {
    events,
    restore: () => {
      console.info = original;
    },
  };
}

function controlFor(store: AgentControlStore) {
  return new AgentControl(
    store,
    { publish: async () => {} },
    { run: async (_id, work) => work() },
    { timeoutMs: 0, fallbackMs: 0 },
  );
}

test("logs a user control request, published command, and terminal wait outcome", async () => {
  const { store } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    state: null,
  });
  const capture = captureInfo();
  try {
    const control = controlFor(store);
    await expect(
      control.execute({
        userId: "owner",
        workspaceId: "w",
        agentId: "a",
        requestId: "control-request",
        action: "stop",
      }),
    ).resolves.toMatchObject({ action: "stop", phase: "pending" });
  } finally {
    capture.restore();
  }
  expect(capture.events).toEqual([
    {
      event: "agent_control:request_started",
      action: "stop",
      request_id: "control-request",
      agent_id: "a",
      workspace_id: "w",
    },
    {
      event: "agent_control:command_published",
      action: "stop",
      phase: "stopping",
      request_id: "control-request",
      agent_id: "a",
      workspace_id: "w",
      computer_id: "c",
      epoch: 1,
    },
    {
      event: "agent_control:request_finished",
      action: "stop",
      request_id: "control-request",
      agent_id: "a",
      workspace_id: "w",
      operation_action: "stop",
      operation_request_id: "control-request",
      phase: "pending",
      outcome: "pending",
      duration_ms: expect.any(Number),
    },
  ]);
});

test("logs an accepted daemon result with the control scope", async () => {
  const { store } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "control-request",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 1,
      action: "stop",
      phase: "stopping",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const capture = captureInfo();
  try {
    await controlFor(store).result(
      { workspaceId: "w", computerId: "c" },
      {
        protocolMajor: 1,
        requestId: "control-request",
        workspaceId: "w",
        computerId: "c",
        agentId: "a",
        provider: "pi",
        epoch: 1,
        phase: "stopped",
        sequence: 1,
      },
    );
  } finally {
    capture.restore();
  }
  expect(capture.events).toEqual([
    {
      event: "agent_control:result_received",
      action: "stop",
      phase: "stopped",
      request_id: "control-request",
      agent_id: "a",
      workspace_id: "w",
      computer_id: "c",
      epoch: 1,
      sequence: 1,
    },
  ]);
});

test("correlates a user Start with an already-running control operation", async () => {
  const { store } = pendingOpStore({
    id: "a",
    ownerId: "owner",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig,
    state: {
      version: 1,
      protocolMajor: 1,
      requestId: "first",
      workspaceId: "w",
      computerId: "c",
      agentId: "a",
      provider: "pi",
      epoch: 4,
      action: "restart",
      phase: "starting",
      configRevision: agentControlRevision(runtimeConfig),
      controlSequence: 0,
      sessionSequence: 0,
    },
  });
  const capture = captureInfo();
  try {
    const result = await controlFor(store).execute({
      userId: "owner",
      workspaceId: "w",
      agentId: "a",
      requestId: "second",
      action: "start",
    });
    expect(result).toMatchObject({ requestId: "first", action: "restart", phase: "pending" });
  } finally {
    capture.restore();
  }
  expect(
    capture.events.find((event) => event.event === "agent_control:request_finished"),
  ).toMatchObject({
    action: "start",
    request_id: "second",
    operation_action: "restart",
    operation_request_id: "first",
  });
});
