import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { decodeAgentStartIntent } from "@lrm/coforge-sdk/internal";
import {
  AgentControlPublisher,
  START_INTENT_INVALID_ERROR_CODE,
} from "#src/server/agents/agent-control-publisher.server";
import type {
  AgentControlAgent,
  AgentControlState,
  AgentControlStore,
} from "#src/server/agents/agent-control-types.server";

const state: AgentControlState = {
  workspaceId: "w",
  computerId: "c",
  action: "start",
  phase: "starting",
  provider: "pi",
  requestId: "r1",
  epoch: 2,
  controlSequence: 0,
  launchId: "l1",
} as AgentControlState;

afterEach(() => mock.restore());

const badRecovery = {
  unreadSummary: {},
  unreadConversationIds: {},
  resumeMessages: [
    {
      messageId: "m",
      deliveryId: "d",
      conversationId: "",
      sequence: 1,
      target: "@ada",
      latestSenderKind: "human" as const,
      latestSenderHandle: "frank",
      latestSenderDescription: "",
      body: "hi",
    },
  ],
};

function fixture(stored: AgentControlState) {
  const agent: AgentControlAgent = {
    id: "a",
    ownerId: "o",
    visibility: "public",
    workspaceId: "w",
    computerId: "c",
    runtimeConfig: {
      runtime: "pi",
      provider: { kind: "default" },
      model: "",
      modelProvider: "",
      reasoning: "",
    },
    state,
  };
  const db = { agent: { ...agent, state: stored } };
  const store = {
    get: async () => structuredClone(db.agent),
    replace: async (before: AgentControlAgent, next: AgentControlState) => {
      if (JSON.stringify(before.state) !== JSON.stringify(db.agent.state)) return false;
      db.agent = { ...db.agent, state: next };
      return true;
    },
  } as unknown as AgentControlStore;
  const published: unknown[] = [];
  const info = spyOn(console, "info").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  const publisher = new AgentControlPublisher(
    store,
    { publish: async (...args) => void published.push(args) },
    () => 1234,
  );
  return { agent, db, publisher, published, info };
}

test("a Start the Daemon would refuse settles failed with a visible code and is not published", async () => {
  const { agent, db, publisher, published, info } = fixture(state);
  await publisher.publish(agent, state, badRecovery);
  expect(published).toEqual([]);
  expect(info).not.toHaveBeenCalled();
  expect(db.agent.state).toMatchObject({
    phase: "failed",
    errorCode: START_INTENT_INVALID_ERROR_CODE,
    failedAtMs: 1234,
    failedStreak: 1,
    requestId: "r1",
    epoch: 2,
  });
});

test("a newer operation that landed first is not overwritten", async () => {
  const newer = { ...state, requestId: "r2", epoch: 3 } as AgentControlState;
  const { agent, db, publisher, published } = fixture(newer);
  await publisher.publish(agent, state, badRecovery);
  expect(published).toEqual([]);
  expect(db.agent.state).toEqual(newer);
});

test("a copy made stale by the launch id still settles the same operation failed", async () => {
  const minted = { ...state, launchId: "l2" } as AgentControlState;
  const { agent, db, publisher } = fixture(minted);
  await publisher.publish(agent, state, badRecovery);
  expect(db.agent.state).toMatchObject({
    phase: "failed",
    errorCode: START_INTENT_INVALID_ERROR_CODE,
    launchId: "l2",
  });
});

test("the managed Start publishes the repository's scoped unread summary proof", async () => {
  const { agent, publisher, published } = fixture(state);
  const recovery = {
    unreadSummary: { "#ops": 2 },
    unreadConversationIds: { "#ops": "ops-conversation" },
    lastUnreadSequences: { "#ops": 123 },
  };
  await publisher.publish(agent, state, recovery);
  expect(published).toHaveLength(1);
  const [, bytes] = published[0] as [string, Uint8Array];
  expect(decodeAgentStartIntent(bytes)).toMatchObject(recovery);
});
