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

test("the proxy hands each management operation on, a logo's large body included", async () => {
  const calls: AgentAppRequest[] = [];
  const { call } = proxyWith(async (request) => {
    calls.push(request);
    return Response.json({ ok: true });
  });
  const logo = {
    operation: "logo_set",
    clientKey: "acme",
    contentType: "image/png",
    dataBase64: "A".repeat(300 * 1024),
  };
  const bodies = [
    { operation: "update", clientKey: "acme", changes: { name: "Acme", homepageUrl: null } },
    logo,
    { operation: "logo_clear", clientKey: "acme" },
    { operation: "transfer_owner", clientKey: "acme", toAgent: "bob" },
    { operation: "delete", clientKey: "acme" },
    { operation: "share_link_create", clientKey: "acme", expiresDays: 7 },
    { operation: "share_link_status", clientKey: "acme" },
    { operation: "share_link_revoke", clientKey: "acme" },
    { operation: "request_publish", clientKey: "acme" },
    { operation: "request_unpublish", clientKey: "acme" },
  ];
  for (const body of bodies) expect((await call(body)).status).toBe(200);
  expect(calls).toEqual(bodies as AgentAppRequest[]);
  for (const body of [
    { operation: "update", clientKey: "acme", changes: {} },
    { operation: "share_link_create", clientKey: "acme", expiresDays: 400 },
    { operation: "transfer_owner", clientKey: "acme" },
  ])
    expect((await call(body)).status).toBe(400);
});

test("the connection sends each management operation to its cloud route with its fields", async () => {
  const seen: { method: string; path: string; body: string }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.text(),
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

  const requests: AgentAppRequest[] = [
    { operation: "update", clientKey: "acme", changes: { scopes: [] } },
    { operation: "logo_set", clientKey: "acme", contentType: "image/png", dataBase64: "AA==" },
    { operation: "logo_clear", clientKey: "acme" },
    { operation: "transfer_owner", clientKey: "acme", toAgent: "bob" },
    { operation: "delete", clientKey: "acme" },
    { operation: "share_link_create", clientKey: "acme", expiresDays: 30 },
    { operation: "share_link_status", clientKey: "acme" },
    { operation: "share_link_revoke", clientKey: "acme" },
    { operation: "request_publish", clientKey: "acme" },
    { operation: "request_unpublish", clientKey: "acme" },
  ];
  for (const request of requests) await transport.agentApp(request, AGENT_API_KEY);
  const base = "/api/agent/v1/apps/owned/acme";
  expect(seen).toEqual([
    { method: "PATCH", path: base, body: '{"scopes":[]}' },
    {
      method: "PUT",
      path: `${base}/logo`,
      body: '{"contentType":"image/png","dataBase64":"AA=="}',
    },
    { method: "DELETE", path: `${base}/logo`, body: "" },
    { method: "POST", path: `${base}/transfer-owner`, body: '{"toAgent":"bob"}' },
    { method: "DELETE", path: base, body: "" },
    { method: "POST", path: `${base}/share-link`, body: '{"expiresDays":30}' },
    { method: "GET", path: `${base}/share-link`, body: "" },
    { method: "DELETE", path: `${base}/share-link`, body: "" },
    { method: "POST", path: `${base}/publish-request`, body: "" },
    { method: "POST", path: `${base}/unpublish-request`, body: "" },
  ]);
});
