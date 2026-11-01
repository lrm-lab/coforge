import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes, type AgentTaskConversationRequest } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";

/** `coforge task view|read|reply|follow|unfollow|list --following` through the daemon: the local
 * proxy admits the six routes and hands each to the runtime as one request, and the connection
 * forwards it to the cloud with the Agent's credentials, answering the cloud's response as it came. */

const AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;
const routes = agentApiRoutes.proxy.taskConversations;
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function proxyWith(
  handler: (context: string, request: AgentTaskConversationRequest) => Promise<Response>,
) {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      agentTaskConversation: async (context, request) => handler(context, request),
    },
  });
  closers.push(() => proxy.close());
  const token = proxy.issue("agent-a", AGENT_API_KEY);
  const endpoint = (path: string) => new URL(path, proxy.url);
  return { token, endpoint };
}

const post = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the proxy hands each GET route to the runtime with its known query and answers the cloud's response", async () => {
  const calls: unknown[] = [];
  const { token, endpoint } = proxyWith(async (context, request) => {
    calls.push({ context, request });
    return Response.json({ ok: true });
  });
  const headers = { authorization: `Bearer ${token}` };
  const view = new URL(endpoint(routes.view.path));
  view.search = "?channel=%23general&task_number=7&limit=5&ignored=1";
  const read = new URL(endpoint(routes.read.path));
  read.search = "?channel=dm%3A%40ada&task_number=3&before=abc&unread=true&limit=10";
  const responses = [
    await fetch(view, { headers }),
    await fetch(read, { headers }),
    await fetch(endpoint(routes.following.path), { headers }),
  ];
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  expect(calls).toEqual([
    {
      context: "agent-a",
      request: {
        route: "view",
        query: { channel: "#general", task_number: "7", limit: "5" },
      },
    },
    {
      context: "agent-a",
      request: {
        route: "read",
        query: { channel: "dm:@ada", task_number: "3", before: "abc", limit: "10", unread: "true" },
      },
    },
    { context: "agent-a", request: { route: "following" } },
  ]);
});

test("the proxy hands each POST route to the runtime with its known fields and carries the cloud's refusal through", async () => {
  const calls: AgentTaskConversationRequest[] = [];
  const { token, endpoint } = proxyWith(async (_context, request) => {
    calls.push(request);
    return Response.json({ error: "not found" }, { status: 404 });
  });
  const ref = { channel: "#general", task_number: 7 };
  const replies = [
    await fetch(
      endpoint(routes.reply.path),
      post(token, { ...ref, content: "hi", idempotencyKey: "k", extra: true }),
    ),
    await fetch(endpoint(routes.follow.path), post(token, ref)),
    await fetch(endpoint(routes.unfollow.path), post(token, { ...ref, reason: "done here" })),
  ];
  expect(replies.map((response) => response.status)).toEqual([404, 404, 404]);
  expect(await replies[0]!.json()).toEqual({ error: "not found" });
  expect(calls).toEqual([
    { route: "reply", body: { ...ref, content: "hi", idempotencyKey: "k" } },
    { route: "follow", body: ref },
    { route: "unfollow", body: { ...ref, reason: "done here" } },
  ]);
});

test("the proxy refuses a request outside the contract, and an unknown caller", async () => {
  const { token, endpoint } = proxyWith(async () => {
    throw new Error("should not be called");
  });
  const headers = { authorization: `Bearer ${token}` };
  const bad = [
    { path: routes.view.path, search: "?task_number=7" },
    { path: routes.view.path, search: "?channel=%23general&task_number=0" },
    { path: routes.read.path, search: "?channel=%23general&task_number=x" },
  ];
  for (const { path, search } of bad) {
    const url = new URL(endpoint(path));
    url.search = search;
    expect((await fetch(url, { headers })).status).toBe(400);
  }
  const ref = { channel: "#general", task_number: 7 };
  for (const [path, body] of [
    [routes.reply.path, ref],
    [routes.reply.path, { ...ref, content: "hi" }],
    [routes.follow.path, { channel: "", task_number: 7 }],
    [routes.unfollow.path, { ...ref, reason: 5 }],
  ] as const)
    expect((await fetch(endpoint(path), post(token, body))).status).toBe(400);
  expect((await fetch(endpoint(routes.following.path))).status).toBe(401);
});

function fakeClient(): CentrifugeWorkspaceClient {
  let connected = () => {};
  return {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect() {
      connected();
    },
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
}

test("the connection sends each task conversation request to the cloud with the daemon's and the Agent's keys", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
        agentApiKey: request.headers.get("x-coforge-agent-api-key"),
        body: request.method === "POST" ? await request.json() : undefined,
      });
      return Response.json({ ok: true }, { status: 200 });
    },
  });
  closers.push(() => void server.stop(true));
  const transport = new DaemonConnection("wss://cloud.example", fakeClient);
  await transport.start("daemon-token", {
    computerId: "computer-a",
    workspaceId: "workspace-a",
    serverHttpUrl: server.url.origin,
  });
  closers.push(() => void transport.stop());

  await transport.agentTaskConversation(
    { route: "view", query: { channel: "#general", task_number: "7" } },
    AGENT_API_KEY,
  );
  await transport.agentTaskConversation(
    { route: "reply", body: { channel: "#general", task_number: 7, content: "hi" } },
    AGENT_API_KEY,
  );
  const auth = { authorization: "Bearer daemon-token", agentApiKey: `Bearer ${AGENT_API_KEY}` };
  expect(seen).toEqual([
    {
      method: "GET",
      path: "/api/agent/v1/tasks/view?channel=%23general&task_number=7",
      ...auth,
      body: undefined,
    },
    {
      method: "POST",
      path: "/api/agent/v1/tasks/reply",
      ...auth,
      body: { channel: "#general", task_number: 7, content: "hi" },
    },
  ]);
});
