import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes, type AgentAppRequest } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import {
  DaemonConnection,
  type CentrifugeWorkspaceClient,
} from "#src/connection/daemon-connection";

/** `coforge app status|list --owned|rotate-secret` through the daemon: the local proxy admits one
 * operation route, and the connection forwards each operation to its cloud route with the Agent's
 * credentials. The secret travels only in the cloud's answer. */

const AGENT_API_KEY = `sk_agent_${"a".repeat(43)}`;
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function proxyWith(agentApp: (request: AgentAppRequest) => Promise<Response>) {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      agentApp: async (_context, request) => agentApp(request),
    },
  });
  closers.push(() => proxy.close());
  const token = proxy.issue("agent-a", AGENT_API_KEY);
  const call = (body: unknown) =>
    fetch(new URL(agentApiRoutes.proxy.appRegistrations.path, proxy.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { call };
}

test("the proxy hands each operation to the runtime and answers the cloud's response", async () => {
  const calls: AgentAppRequest[] = [];
  const { call } = proxyWith(async (request) => {
    calls.push(request);
    return Response.json({ ok: true });
  });
  for (const body of [
    { operation: "register_status", card: "card-1" },
    { operation: "register_status", client: "acme-notes" },
    { operation: "owned_list" },
    { operation: "rotate_secret", clientKey: "acme-notes" },
  ])
    expect((await call(body)).status).toBe(200);
  expect(calls).toEqual([
    { operation: "register_status", card: "card-1" },
    { operation: "register_status", client: "acme-notes" },
    { operation: "owned_list" },
    { operation: "rotate_secret", clientKey: "acme-notes" },
  ]);
});

test("the proxy refuses a body outside the contract before the runtime sees it", async () => {
  const { call } = proxyWith(async () => {
    throw new Error("should not be called");
  });
  for (const body of [
    { operation: "register_status" },
    { operation: "register_status", card: "a", client: "b" },
    { operation: "owned_list", output: "/tmp/x" },
    { operation: "rotate_secret" },
    { operation: "delete" },
  ])
    expect((await call(body)).status).toBe(400);
});

function fakeClient(): CentrifugeWorkspaceClient {
  let connected = () => {};
  return {
    on(event, callback) {
      if (event === "connected") connected = callback as () => void;
    },
    connect: () => connected(),
    disconnect() {},
    rpc: async () => new Uint8Array(),
  };
}

test("the connection sends each operation to its cloud route", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get("authorization"),
        agentApiKey: request.headers.get("x-coforge-agent-api-key"),
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

  await transport.agentApp({ operation: "register_status", card: "card 1" }, AGENT_API_KEY);
  await transport.agentApp({ operation: "register_status", client: "acme" }, AGENT_API_KEY);
  await transport.agentApp({ operation: "owned_list" }, AGENT_API_KEY);
  await transport.agentApp({ operation: "rotate_secret", clientKey: "acme" }, AGENT_API_KEY);
  const headers = {
    authorization: "Bearer daemon-token",
    agentApiKey: `Bearer ${AGENT_API_KEY}`,
  };
  expect(seen).toEqual([
    {
      method: "GET",
      path: "/api/agent/v1/apps/registrations/status",
      query: "?card=card+1",
      ...headers,
    },
    {
      method: "GET",
      path: "/api/agent/v1/apps/registrations/status",
      query: "?client=acme",
      ...headers,
    },
    { method: "GET", path: "/api/agent/v1/apps/owned", query: "", ...headers },
    { method: "POST", path: "/api/agent/v1/apps/owned/acme/rotate-secret", query: "", ...headers },
  ]);
});
