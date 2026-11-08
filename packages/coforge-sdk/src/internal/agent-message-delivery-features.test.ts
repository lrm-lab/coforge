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
