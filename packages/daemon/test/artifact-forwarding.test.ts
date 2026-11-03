import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";

/** `coforge artifact create|read|push|history|revert` through the daemon (task #385): the local
 * proxy admits one artifact operation with exactly its own fields, and the connection forwards it
 * to the cloud with the Agent's credentials, answering the cloud's response as it came. */

const AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;
const route = agentApiRoutes.proxy.artifacts;
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function proxyWith(handler: (request: AgentArtifactRequest) => Promise<Response>) {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      agentArtifact: async (_context, request) => handler(request),
    },
  });
  closers.push(() => proxy.close());
  const token = proxy.issue("agent-a", AGENT_API_KEY);
  return { token, url: new URL(route.path, proxy.url) };
}

const post = (token: string, body: unknown) => ({
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("the proxy hands an artifact operation to the runtime and answers the cloud's response", async () => {
  const calls: AgentArtifactRequest[] = [];
  const { token, url } = proxyWith(async (request) => {
    calls.push(request);
    return Response.json({ status: "conflict" }, { status: 200 });
  });
  // A document of a few hundred KiB fits: the route admits more than the proxy's usual 64 KiB.
  const text = "x".repeat(300 * 1024);
  const response = await fetch(
    url,
    post(token, { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", text }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "conflict" });
  expect(calls).toEqual([
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", text },
  ]);
});

test("the proxy refuses an operation outside the contract", async () => {
  const { token, url } = proxyWith(async () => {
    throw new Error("should not be called");
  });
  for (const body of [
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", exactBase: true },
    { operation: "delete", artifact: "a1" },
    { operation: "read" },
  ])
    expect((await fetch(url, post(token, body))).status).toBe(400);
  expect((await fetch(url, { method: "POST" })).status).toBe(401);
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

test("the connection sends an artifact operation to the cloud with the daemon's and the Agent's keys", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        agentApiKey: request.headers.get("x-coforge-agent-api-key"),
        body: await request.json(),
      });
      return Response.json({ ok: true });
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

  await transport.agentArtifact({ operation: "read", artifact: "a1", version: 2 }, AGENT_API_KEY);
  expect(seen).toEqual([
    {
      method: "POST",
      path: "/api/agent/v1/artifacts",
      authorization: "Bearer daemon-token",
      agentApiKey: `Bearer ${AGENT_API_KEY}`,
      body: { operation: "read", artifact: "a1", version: 2 },
    },
  ]);
});
