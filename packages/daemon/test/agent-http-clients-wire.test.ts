import { expect, test } from "bun:test";
import type { AgentMessageRequest } from "@lrm/coforge-sdk/internal";
import { createAgentMessageHttpClient } from "../src/connection/agent-http-clients";
import { AgentTransportError } from "../src/connection/agent-transport-error";

// Pins what the message client puts on the wire for the routes that share `sendAgentJson` /
// `getAgentJson`: method, URL, headers, body and whether a deadline is attached.

type Captured = {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: string;
  hasSignal: boolean;
};

const keys = {
  url: "https://server.example/api/agent/v1/route",
  agentApiKey: "sk_agent_test",
  daemonApiKey: "daemon-token",
};
const authHeaders = {
  authorization: "Bearer daemon-token",
  "x-coforge-agent-api-key": "Bearer sk_agent_test",
};
const jsonHeaders = { ...authHeaders, "content-type": "application/json" };

function recordingClient(responseBody: unknown) {
  const calls: Captured[] = [];
  const client = createAgentMessageHttpClient(async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method,
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body as string | undefined,
      hasSignal: init?.signal !== undefined,
    });
    return Response.json(responseBody);
  });
  return { client, calls };
}

const request = (fields: Partial<AgentMessageRequest>) =>
  ({
    idempotencyKey: "key-1",
    agentId: "agent-a",
    workspaceId: "ws-1",
    ...fields,
  }) as AgentMessageRequest;

test("send POSTs the send body with a deadline", async () => {
  const { client, calls } = recordingClient({ state: "sent", decision: "forward" });
  await client.requestSend!({
    ...keys,
    request: request({ operation: "send", target: "#general", content: "hi", mentions: [] }),
  });
  expect(calls).toEqual([
    {
      url: keys.url,
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        idempotencyKey: "key-1",
        target: "#general",
        content: "hi",
        mentions: [],
      }),
      hasSignal: true,
    },
  ]);
});

test("send reconciliation POSTs only the key, the target and reconcileOnly, with a deadline", async () => {
  const { client, calls } = recordingClient({ state: "not_found" });
  await client.requestSendReconciliation!({
    ...keys,
    request: { idempotencyKey: "key-1", agentId: "agent-a", workspaceId: "ws-1", target: "#g" },
  });
  expect(calls).toEqual([
    {
      url: keys.url,
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ idempotencyKey: "key-1", target: "#g", reconcileOnly: true }),
      hasSignal: true,
    },
  ]);
});

test("channel mute and thread unfollow POST only the key, without a deadline", async () => {
  const { client, calls } = recordingClient({ idempotencyKey: "key-1" });
  await client.requestChannelMute!({
    ...keys,
    request: { ...request({ operation: "mute", target: "#g" }), muted: true },
  });
  await client.requestThreadUnfollow!({
    ...keys,
    request: request({ operation: "thread-unfollow", target: "#g:abc" }),
  });
  const expected = {
    url: keys.url,
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ idempotencyKey: "key-1" }),
    hasSignal: false,
  };
  expect(calls).toEqual([expected, expected]);
});

test("reaction sends the key and the emoji with the caller's method", async () => {
  const { client, calls } = recordingClient({ idempotencyKey: "key-1", messageId: "m-1" });
  for (const method of ["POST", "DELETE"] as const)
    await client.requestReaction!({
      ...keys,
      method,
      request: request({ operation: "react", emoji: "👍" }),
    });
  expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  for (const call of calls)
    expect(call).toMatchObject({
      url: keys.url,
      headers: jsonHeaders,
      body: JSON.stringify({ idempotencyKey: "key-1", emoji: "👍" }),
      hasSignal: false,
    });
});

test("resolve GETs with the key in the query string and no body or deadline", async () => {
  const { client, calls } = recordingClient({ idempotencyKey: "key-1", message: { id: "m-1" } });
  await client.requestResolve!({ ...keys, request: request({ operation: "resolve" }) });
  expect(calls).toEqual([
    {
      url: `${keys.url}?idempotencyKey=key-1`,
      method: "GET",
      headers: authHeaders,
      body: undefined,
      hasSignal: false,
    },
  ]);
});

test("a malformed 2xx body is a protocol mismatch on every one of these routes", async () => {
  const { client } = recordingClient({ unexpected: true });
  const notJson = createAgentMessageHttpClient(async () => new Response("nope"));
  const attempts = [
    client.requestSend!({ ...keys, request: request({ operation: "send", target: "#g" }) }),
    client.requestSendReconciliation!({
      ...keys,
      request: { idempotencyKey: "key-1", agentId: "agent-a", workspaceId: "ws-1", target: "#g" },
    }),
    client.requestResolve!({ ...keys, request: request({ operation: "resolve" }) }),
    notJson.requestChannelMute!({
      ...keys,
      request: { ...request({ operation: "mute" }), muted: true },
    }),
    notJson.requestThreadUnfollow!({ ...keys, request: request({ operation: "thread-unfollow" }) }),
    notJson.requestReaction!({ ...keys, method: "POST", request: request({ operation: "react" }) }),
  ];
  for (const attempt of attempts) {
    const error = await attempt.catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentTransportError);
    expect(error).toMatchObject({
      failureClass: "protocol_mismatch",
      causeCode: "AGENT_RESPONSE_SHAPE_INVALID",
      upstreamStatus: 200,
    });
  }
});
