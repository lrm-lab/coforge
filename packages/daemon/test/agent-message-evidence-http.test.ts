import { expect, test } from "bun:test";
import { createAgentMessageHttpClient } from "#src/connection/agent-http-clients";
import { adaptAgentSendResponse } from "#src/connection/agent-message-adapters";
import { adaptAgentHistoryResponse } from "#src/connection/agent-history-response";

const input = {
  url: "https://server.example/api/agent/v1/messages",
  agentApiKey: "fixture-agent",
  daemonApiKey: "fixture-daemon",
};
const identity = {
  idempotencyKey: "message-request",
  workspaceId: "workspace-a",
  agentId: "agent-a",
  target: "#general",
};

test("message history requests an authoritative consumption scope", async () => {
  const client = createAgentMessageHttpClient(async (url) => {
    expect(new URL(String(url)).searchParams.get("consumptionScope")).toBe("true");
    return Response.json({
      idempotencyKey: identity.idempotencyKey,
      messages: [],
      hasOlder: false,
      hasNewer: false,
    });
  });
  await client.requestRead!({ ...input, request: { ...identity, operation: "read" } });
});

test("message send carries scoped evidence without legacy numeric fields", async () => {
  const consumptionEvidence = [
    { target: { conversationId: "conversation-a" }, entry: { seq: 7, exactSeqs: [9] } },
  ];
  const client = createAgentMessageHttpClient(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.consumptionEvidence).toEqual(consumptionEvidence);
    expect(body).not.toHaveProperty("seenUpToSeq");
    expect(body).not.toHaveProperty("seenExactSeqs");
    return Response.json({
      idempotencyKey: identity.idempotencyKey,
      state: "sent",
      decision: "forward",
      messageId: "message-1",
      heldMessages: [],
    });
  });
  await client.requestSend!({
    ...input,
    request: {
      ...identity,
      operation: "send",
      content: "fixture",
      seenUpToSeq: 7,
      seenExactSeqs: [9],
      consumptionEvidence,
    },
  });
});

test("send response retains only a valid authority for its consumption numbers", () => {
  const response = {
    idempotencyKey: identity.idempotencyKey,
    state: "sent" as const,
    decision: "forward" as const,
    messageId: "message-1",
    heldMessages: [],
    seenUpToSeq: 31,
  };
  const consumptionScope = { conversationId: "conversation-a", threadRootId: "thread-a" };
  const scoped = { ...response, consumptionScope };
  expect(adaptAgentSendResponse(scoped).writeConsumptionScope).toEqual(consumptionScope);
  const malformed = { ...response, consumptionScope: { ...consumptionScope, threadRootId: "" } };
  expect(adaptAgentSendResponse(malformed).writeConsumptionScope).toBeUndefined();
  expect(adaptAgentSendResponse(response).writeConsumptionScope).toBeUndefined();
});

test("history preserves server-confirmed channel and thread identity", () => {
  const response = {
    idempotencyKey: identity.idempotencyKey,
    messages: [],
    hasOlder: false,
    hasNewer: false,
    modelSeenUpToSeq: 31,
  };
  const channel = { ...response, consumptionScope: { conversationId: "conversation-a" } };
  expect(adaptAgentHistoryResponse(channel, identity).consumptionScope).toEqual({
    agentId: identity.agentId,
    target: identity.target,
    channelType: "dm",
    conversationId: "conversation-a",
  });
  const thread = {
    ...response,
    consumptionScope: {
      agentId: identity.agentId,
      target: "#general:thread-a",
      channelType: "thread" as const,
      conversationId: "conversation-a",
      threadRootId: "thread-a",
    },
  };
  expect(adaptAgentHistoryResponse(thread, identity).consumptionScope).toEqual(
    thread.consumptionScope,
  );
  const malformed = { ...thread, consumptionScope: { ...thread.consumptionScope, agentId: 5 } };
  expect(adaptAgentHistoryResponse(malformed, identity).consumptionScope).toBeUndefined();
});
