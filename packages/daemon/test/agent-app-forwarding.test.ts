import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes, type AgentAppRequest } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "#src/connection/daemon-connection";

/** `coforge app list|token` through the daemon: the local proxy admits the two routes and hands
 * them to the runtime, and the connection forwards each to the cloud with the Agent's credentials,
 * answering the cloud's response as it came. */

const AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function proxyWith(agentApp: (context: string, request: AgentAppRequest) => Promise<Response>) {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      agentApp: async (context, request) => agentApp(context, request),
    },
  });
  closers.push(() => proxy.close());
  const token = proxy.issue("agent-a", AGENT_API_KEY);
  const endpoint = (path: string) => new URL(path, proxy.url);
  return { token, endpoint };
}

test("the proxy forwards the app list for the calling Agent and answers the cloud's response", async () => {
  const calls: unknown[] = [];
  const listed = { ok: true, apps: [] };
  const { token, endpoint } = proxyWith(async (context, request) => {
    calls.push({ context, request });
    return Response.json(listed);
  });
  const response = await fetch(endpoint(agentApiRoutes.proxy.apps.list.path), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(listed);
  expect(calls).toEqual([{ context: "agent-a", request: { operation: "list" } }]);
});

test("the proxy forwards a token request and carries the cloud's refusal through", async () => {
  const calls: unknown[] = [];
  const refusal = { ok: false, errorCode: "target_invalid", error: "not a member" };
  const { token, endpoint } = proxyWith(async (context, request) => {
    calls.push({ context, request });
    return Response.json(refusal, { status: 422 });
  });
  const body = { target: "#ops" };
  const response = await fetch(endpoint(agentApiRoutes.proxy.apps.token.path("acme-notes")), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual(refusal);
  expect(calls).toEqual([
    { context: "agent-a", request: { operation: "token", appKey: "acme-notes", ...body } },
  ]);
});

test("the proxy refuses a token request outside the contract, and an unknown caller", async () => {
  const { token, endpoint } = proxyWith(async () => {
    throw new Error("should not be called");
  });
  const url = endpoint(agentApiRoutes.proxy.apps.token.path("acme-notes"));
  for (const body of [
    { target: "" },
    { target: "#ops", scope: "email" },
    { idempotencyKey: "k" },
  ]) {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
  const anonymous = await fetch(endpoint(agentApiRoutes.proxy.apps.list.path));
  expect(anonymous.status).toBe(401);
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

test("the connection sends each app request to the cloud with the daemon's and the Agent's keys", async () => {
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
        body: request.method === "POST" ? await request.json() : undefined,
      });
      return Response.json({ ok: true, status: "not_installed" }, { status: 200 });
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

  const listed = await transport.agentApp({ operation: "list" }, AGENT_API_KEY);
  const token = await transport.agentApp(
    { operation: "token", appKey: "acme notes", target: "#ops" },
    AGENT_API_KEY,
  );
  expect([listed.status, await token.json()]).toEqual([200, { ok: true, status: "not_installed" }]);
  expect(seen).toEqual([
    {
      method: "GET",
      path: "/api/agent/v1/apps",
      authorization: "Bearer daemon-token",
      agentApiKey: `Bearer ${AGENT_API_KEY}`,
      body: undefined,
    },
    {
      method: "POST",
      path: "/api/agent/v1/apps/acme%20notes/token",
      authorization: "Bearer daemon-token",
      agentApiKey: `Bearer ${AGENT_API_KEY}`,
      body: { target: "#ops" },
    },
  ]);
});
