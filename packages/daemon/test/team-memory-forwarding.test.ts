import { expect, test } from "bun:test";
import { startAgentProxy } from "#src/agent-proxy";
import { DaemonConnection } from "#src/connection/daemon-connection";
import type { CentrifugeWorkspaceClient } from "#src/connection/centrifuge-workspace-client";
import { run } from "../../coforge/index";
import { teamMemoryRequests } from "../../coforge/src/team-memory-request";
import type { MessageTransport } from "../../coforge/src/message-transport";

test("team CLI reaches the authenticated cloud, refuses identity overrides and preserves conflict guidance", async () => {
  const seen: unknown[] = [];
  const key = `sk_agent_${"a".repeat(43)}`;
  const cloud = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        body: await request.json(),
        daemon: request.headers.get("authorization"),
        agent: request.headers.get("x-coforge-agent-api-key"),
        path: new URL(request.url).pathname,
      });
      return Response.json({
        status: "review_required",
        entries: [],
        reviewRevision: 3,
        reviewToken: "00000000-0000-4000-8000-000000000099",
      });
    },
  });
  const client = (): CentrifugeWorkspaceClient => {
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
  };
  const connection = new DaemonConnection("wss://cloud.example", client);
  await connection.start("daemon-key", {
    computerId: "computer",
    workspaceId: "workspace",
    serverHttpUrl: cloud.url.origin,
  });
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agent) => agent,
      agentTeamMemory: async (_context, request, apiKey) =>
        connection.agentTeamMemory(request, apiKey),
    },
  });
  try {
    const token = proxy.issue("agent", key);
    const transport = teamMemoryRequests(
      (path) => new URL(path, proxy.url),
      token,
      proxy.url,
    ) as unknown as MessageTransport;
    expect(
      await run(["memory", "search", "--scope", "team", "--query", "域名"], transport),
    ).toContain("--reviewToken 00000000-0000-4000-8000-000000000099");
    expect(seen).toEqual([
      {
        body: { operation: "search", query: "域名", offset: 0 },
        daemon: "Bearer daemon-key",
        agent: `Bearer ${key}`,
        path: "/api/agent/v1/team-memory",
      },
    ]);
    const response = await fetch(new URL("/api/agent/v1/team-memory", proxy.url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ operation: "search", query: "x", workspaceId: "other" }),
    });
    expect(response.status).toBe(400);
    expect(seen).toHaveLength(1);
  } finally {
    proxy.close();
    await connection.stop();
    await cloud.stop(true);
  }
});
