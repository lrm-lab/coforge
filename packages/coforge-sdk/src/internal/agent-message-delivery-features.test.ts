import { expect, test } from "bun:test";
import {
  AGENT_MESSAGE_METHOD,
  WORKSPACE_PROTOCOL_MAJOR,
  decodeAgentMessageDelivery,
  encodeAgentMessageDelivery,
  type AgentMessageDelivery,
} from "./index";

const delivery = (features?: AgentMessageDelivery["features"]): AgentMessageDelivery => ({
  protocolMajor: WORKSPACE_PROTOCOL_MAJOR,
  method: AGENT_MESSAGE_METHOD,
  requestId: "request-1",
  messageId: "message-1",
  deliveryId: "delivery-1",
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-1",
  body: "hello",
  ...(features ? { features } : {}),
});

test("the Workspace's task conversations switch rides the delivery, on or off", () => {
  for (const taskConversations of [true, false])
    expect(
      decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery({ taskConversations })))
        .features,
    ).toEqual({ taskConversations });
});

test("the artifacts switch rides the delivery beside task conversations, on or off", () => {
  for (const artifacts of [true, false])
    expect(
      decodeAgentMessageDelivery(
        encodeAgentMessageDelivery(delivery({ taskConversations: true, artifacts })),
      ).features,
    ).toEqual({ taskConversations: true, artifacts });
});

test("the context view gate rides the delivery on or off", () => {
  for (const agentContextView of [true, false])
    expect(
      decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery({ agentContextView })))
        .features,
    ).toEqual({ agentContextView });
});

test("a delivery naming only task conversations leaves artifacts unknown, not off", () => {
  // A server that predates the artifacts field must not read as documents-off: the daemon
  // compares only the switches a delivery actually states.
  expect(
    decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery({ taskConversations: false })))
      .features,
  ).toEqual({ taskConversations: false });
});

test("a delivery from a server that predates the switch carries none", () => {
  expect(
    decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery())).features,
  ).toBeUndefined();
});

test("the message's notice kind and the server's task-discussion verdict ride the delivery", () => {
  const decoded = decodeAgentMessageDelivery(
    encodeAgentMessageDelivery({
      ...delivery(),
      noticeKind: "task.assigned_you",
      taskDiscussion: true,
    }),
  );
  expect(decoded.noticeKind).toBe("task.assigned_you");
  expect(decoded.taskDiscussion).toBe(true);
});

test("an older server's delivery says nothing about either, and reads back without them", () => {
  const decoded = decodeAgentMessageDelivery(encodeAgentMessageDelivery(delivery()));
  // Absent, not false: a daemon that reads `false` would treat an old server's task delivery as
  // ordinary channel traffic.
  expect(decoded.noticeKind).toBeUndefined();
  expect(decoded.taskDiscussion).toBeUndefined();
  // The server can also say plainly that a delivery is not a task's.
  expect(
    decodeAgentMessageDelivery(encodeAgentMessageDelivery({ ...delivery(), taskDiscussion: false }))
      .taskDiscussion,
  ).toBe(false);
});
