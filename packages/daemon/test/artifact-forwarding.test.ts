import { afterEach, expect, test } from "bun:test";
import {
  agentApiRoutes,
  ARTIFACT_UPLOAD_MAX_BYTES,
  type AgentArtifactRequest,
} from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";

/** `coforge artifact list|read|push|comments|...` through the daemon (task #385): the local
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
    return Response.json({ status: "missing", missing: [SHA] }, { status: 200 });
  });
  // A manifest of 200 files at long paths (some 200 KiB) fits: the route admits more than the
  // proxy's usual 64 KiB.
  const files = Array.from({ length: 200 }, (_, index) => ({
    path: `${"d".repeat(1000)}/${index}.md`,
    sha256: SHA,
  }));
  const push = { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", files };
  const response = await fetch(url, post(token, push));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "missing", missing: [SHA] });
  expect(calls).toEqual([push as AgentArtifactRequest]);
});

test("the proxy refuses an operation outside the contract", async () => {
  const { token, url } = proxyWith(async () => {
    throw new Error("should not be called");
  });
  for (const body of [
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", exactBase: true },
    { operation: "push", artifact: "a1", baseVersion: 2, idempotencyKey: "k", text: "x" },
    { operation: "history", artifact: "a1" },
    { operation: "delete", artifact: "a1" },
    { operation: "read" },
  ])
    expect((await fetch(url, post(token, body))).status).toBe(400);
  expect((await fetch(url, { method: "POST" })).status).toBe(401);
});

test("the proxy passes the comment operations, nested fields included, and refuses a stray one", async () => {
  const calls: AgentArtifactRequest[] = [];
  const { token, url } = proxyWith(async (request) => {
    calls.push(request);
    return Response.json({ ok: true });
  });
  const bodies = [
    { operation: "comments", artifact: "a1", all: true, path: "plan.md" },
    {
      operation: "comment",
      artifact: "a1",
      body: "Why?",
      anchor: { type: "lines", data: { start: 2, end: 3 } },
      idempotencyKey: "k",
    },
    {
      operation: "review",
      artifact: "a1",
      comments: [{ body: "One", path: "a.md", anchor: { type: "file", data: {} } }],
      idempotencyKey: "k",
    },
    { operation: "resolve", artifact: "a1", comment: "c1", note: "Fixed" },
    { operation: "reopen", artifact: "a1", comment: "c1" },
  ];
  for (const body of bodies) expect((await fetch(url, post(token, body))).status).toBe(200);
  expect(calls).toEqual(bodies as AgentArtifactRequest[]);
  // A stray field in a nested object is refused as a stray top-level field is.
  for (const body of [
    {
      operation: "review",
      artifact: "a1",
      comments: [{ body: "One", authorUserId: "u" }],
      idempotencyKey: "k",
    },
    {
      operation: "comment",
      artifact: "a1",
      body: "x",
      anchor: { type: "lines", data: {}, extra: 1 },
      idempotencyKey: "k",
    },
    { operation: "comments", artifact: "a1", all: "yes" },
  ])
    expect((await fetch(url, post(token, body))).status).toBe(400);
  expect(calls).toHaveLength(bodies.length);
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

const SHA = "a".repeat(64);
const uploadRoute = agentApiRoutes.proxy.artifactFiles.upload;
const downloadRoute = agentApiRoutes.proxy.artifactFiles.download;
/** Bytes that are not valid UTF-8, so any text round trip corrupts them. */
const BINARY = new Uint8Array([0, 255, 254, 128, 10, 13, 200, 1, 2, 3]);

function fileProxy(runtime: {
  agentArtifactUpload?: NonNullable<
    Parameters<typeof startAgentProxy>[0]["runtime"]["agentArtifactUpload"]
  >;
  agentArtifactDownload?: NonNullable<
    Parameters<typeof startAgentProxy>[0]["runtime"]["agentArtifactDownload"]
  >;
}) {
  const proxy = startAgentProxy({
    runtime: { agentMessage: async () => ({}), issueAgentContext: (id: string) => id, ...runtime },
  });
  closers.push(() => proxy.close());
  const token = proxy.issue("agent-a", AGENT_API_KEY);
  const url = (path: string) => new URL(path, proxy.url);
  return { token, url };
}

test("the proxy hands an artifact file upload to the runtime byte for byte and answers its status", async () => {
  const calls: Array<{ sha256: string; bytes: Uint8Array; apiKey: string }> = [];
  const { token, url } = fileProxy({
    agentArtifactUpload: async (_context, { sha256, request }, apiKey) => {
      calls.push({ sha256, bytes: new Uint8Array(await request.arrayBuffer()), apiKey });
      return new Response(null, { status: 204 });
    },
  });
  const response = await fetch(url(uploadRoute.path(SHA)), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    body: BINARY,
  });
  expect(response.status).toBe(204);
  expect(calls).toEqual([{ sha256: SHA, bytes: BINARY, apiKey: AGENT_API_KEY }]);
});

test("the proxy refuses an artifact file upload that is unbounded, too large or not named by a sha256", async () => {
  let calls = 0;
  const { token, url } = fileProxy({
    agentArtifactUpload: async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
  });
  const headers = { authorization: `Bearer ${token}` };
  // A streamed body is sent chunked, with no content-length at all.
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(BINARY);
      controller.close();
    },
  });
  const noLength = await fetch(url(uploadRoute.path(SHA)), {
    method: "PUT",
    headers,
    body: chunked,
  });
  expect(noLength.status).toBe(411);
  // `fetch` recomputes content-length from the body, so the limit meets a genuinely oversized one.
  const tooLarge = await fetch(url(uploadRoute.path(SHA)), {
    method: "PUT",
    keepalive: false,
    headers,
    body: new Uint8Array(ARTIFACT_UPLOAD_MAX_BYTES + 1),
  });
  expect(tooLarge.status).toBe(413);
  const badHash = await fetch(url(uploadRoute.path("not-a-sha")), {
    method: "PUT",
    headers,
    body: BINARY,
  });
  expect(badHash.status).toBe(400);
  const noToken = await fetch(url(uploadRoute.path(SHA)), { method: "PUT", body: BINARY });
  expect(noToken.status).toBe(401);
  expect(calls).toBe(0);
});

test("the proxy hands an artifact file download to the runtime and answers its bytes and content type unchanged", async () => {
  const calls: unknown[] = [];
  const { token, url } = fileProxy({
    agentArtifactDownload: async (_context, request) => {
      calls.push(request);
      return new Response(BINARY, { headers: { "content-type": "image/png" } });
    },
  });
  const headers = { authorization: `Bearer ${token}` };
  const current = await fetch(url(downloadRoute.path("a1", "css/site map.css")), { headers });
  expect(current.status).toBe(200);
  expect(current.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await current.arrayBuffer())).toEqual(BINARY);
  const older = await fetch(`${url(downloadRoute.path("a1", "index.html"))}?version=3`, {
    headers,
  });
  await older.arrayBuffer();
  expect(calls).toEqual([
    { artifact: "a1", path: "css/site map.css" },
    { artifact: "a1", path: "index.html", version: 3 },
  ]);
  const badVersion = await fetch(`${url(downloadRoute.path("a1", "index.html"))}?version=x`, {
    headers,
  });
  expect(badVersion.status).toBe(400);
  expect(calls).toHaveLength(2);
});

test("the proxy forwards the manifest and paging fields of an artifact operation", async () => {
  const calls: AgentArtifactRequest[] = [];
  const { token, url } = proxyWith(async (request) => {
    calls.push(request);
    return Response.json({ ok: true });
  });
  const manifest: AgentArtifactRequest = {
    operation: "push",
    artifact: "a1",
    baseVersion: 2,
    idempotencyKey: "k",
    files: [{ path: "index.html", sha256: SHA }],
    delete: ["old.css"],
    entry: "index.html",
  };
  const listing: AgentArtifactRequest = {
    operation: "list",
    query: "launch plan",
    after: "c1",
    limit: 20,
  };
  for (const body of [manifest, listing])
    expect((await fetch(url, post(token, body))).status).toBe(200);
  expect(calls).toEqual([manifest, listing]);
});

test("the connection sends an artifact file upload and download to the cloud byte for byte", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const { pathname, search } = new URL(request.url);
      const bytes = new Uint8Array(await request.arrayBuffer());
      seen.push({
        method: request.method,
        path: pathname + search,
        authorization: request.headers.get("authorization"),
        agentApiKey: request.headers.get("x-coforge-agent-api-key"),
        contentType: request.headers.get("content-type"),
        bytes: [...bytes],
      });
      return request.method === "PUT"
        ? new Response(null, { status: 204 })
        : new Response(BINARY, { headers: { "content-type": "image/png" } });
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

  const upload = await transport.agentArtifact(
    {
      file: "upload",
      sha256: SHA,
      request: new Request("http://local/upload", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: BINARY,
      }),
    },
    AGENT_API_KEY,
  );
  expect(upload.status).toBe(204);
  const download = await transport.agentArtifact(
    { file: "download", artifact: "a1", path: "css/site.css", version: 2 },
    AGENT_API_KEY,
  );
  expect(download.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(BINARY);
  const keys = { authorization: "Bearer daemon-token", agentApiKey: `Bearer ${AGENT_API_KEY}` };
  expect(seen).toEqual([
    {
      method: "PUT",
      path: `/api/agent/v1/artifacts/uploads/${SHA}`,
      ...keys,
      contentType: "application/octet-stream",
      bytes: [...BINARY],
    },
    {
      method: "GET",
      path: "/api/agent/v1/artifacts/a1/files/css%2Fsite.css?version=2",
      ...keys,
      contentType: null,
      bytes: [],
    },
  ]);
});
