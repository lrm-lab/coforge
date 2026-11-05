import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import {
  announceDirectConversationCreated,
  logAgentCreated,
  logDirectConversationOpened,
} from "#src/server/conversations/direct-conversation-log.server";

/**
 * Task #551: a DM that never reached its list left nothing in the production log to follow. These
 * lines carry ids and outcomes only; a message body, a token or an email address never appears.
 */
let info: Mock<typeof console.info>;
let warn: Mock<typeof console.warn>;
const lines = (mock: Mock<(...args: unknown[]) => void>) =>
  mock.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

beforeEach(() => {
  info = spyOn(console, "info").mockImplementation(() => {});
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

test("opening a DM with an Agent logs who opened it, the Agent and whether it started", () => {
  logDirectConversationOpened({
    workspaceId: "w1",
    conversationId: "c1",
    userId: "u1",
    peer: { agentId: "a1" },
    created: true,
  });
  expect(lines(info)).toEqual([
    {
      event: "direct_conversation.opened",
      workspace_id: "w1",
      conversation_id: "c1",
      user_id: "u1",
      peer_agent_id: "a1",
      created: true,
    },
  ]);
});

test("opening a DM with a member names that member, and an existing DM says so", () => {
  logDirectConversationOpened({
    workspaceId: "w1",
    conversationId: "c2",
    userId: "u1",
    peer: { userId: "u2" },
    created: false,
  });
  expect(lines(info)).toEqual([
    {
      event: "direct_conversation.opened",
      workspace_id: "w1",
      conversation_id: "c2",
      user_id: "u1",
      peer_user_id: "u2",
      created: false,
    },
  ]);
});

test("the dm.created.v1 announcement logs its recipients, their channels and that it went out", async () => {
  const sent: unknown[] = [];
  await announceDirectConversationCreated(
    { viewerChanged: async (input) => void sent.push(input) },
    { workspaceId: "w1", conversationId: "c1", userIds: ["u1", "u2", "u1"] },
  );
  expect(sent).toEqual([
    {
      userIds: ["u1", "u2"],
      event: { type: "dm.created.v1", workspaceId: "w1", conversationId: "c1" },
    },
  ]);
  expect(lines(info)).toEqual([
    {
      event: "direct_conversation.created_announced",
      workspace_id: "w1",
      conversation_id: "c1",
      recipient_user_ids: ["u1", "u2"],
      recipient_count: 2,
      channels: ["chat:user:u1", "chat:user:u2"],
      outcome: "sent",
    },
  ]);
});

test("an announcement that fails is logged as failed, with the error's type and no message", async () => {
  await announceDirectConversationCreated(
    {
      viewerChanged: async () => {
        throw new TypeError("secret-token-123 leaked in a message");
      },
    },
    { workspaceId: "w1", conversationId: "c1", userIds: ["u1"] },
  );
  expect(lines(info)).toEqual([]);
  const [line] = lines(warn);
  expect(line).toEqual({
    event: "direct_conversation.created_announced",
    workspace_id: "w1",
    conversation_id: "c1",
    recipient_user_ids: ["u1"],
    recipient_count: 1,
    channels: ["chat:user:u1"],
    outcome: "failed",
    error_type: "TypeError",
  });
  expect(JSON.stringify(line)).not.toContain("secret-token-123");
});

test("creating an Agent logs the Agent, its creator and its Computer", () => {
  logAgentCreated({ workspaceId: "w1", agentId: "a1", creatorUserId: "u1", computerId: "m1" });
  expect(lines(info)).toEqual([
    {
      event: "agent.created",
      workspace_id: "w1",
      agent_id: "a1",
      creator_user_id: "u1",
      computer_id: "m1",
    },
  ]);
});
