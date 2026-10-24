import { afterEach, expect, test } from "bun:test";
import { startAgentProxy } from "#src/agent-proxy";
import { createAgentMessageHttpClient } from "#src/connection/agent-http-clients";
import { adaptAgentSearchResponse } from "#src/connection/agent-http-clients";
import { AgentMessageAttentionIndex } from "#src/daemon-runtime/agent-message-attention-index";
import { AgentMessageOperations } from "#src/daemon-runtime/agent-message-operations";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const hit = {
  id: "message-1",
  sequence: 1,
  senderKind: "human" as const,
  senderHandle: "ada",
  senderDescription: "",
  target: "@ada",
  body: "hi",
  createdAt: "2026-09-16T00:00:00.000Z",
  attachments: [],
};

test("the proxy forwards a search cursor and refuses an empty or non-string one", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const proxy = startAgentProxy({
    runtime: {
      issueAgentContext: () => "trusted-context",
      agentMessage: async (_context, request) => {
        calls.push(request);
        return { messages: [] };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-1", `sk_agent_${"a".repeat(43)}`);
  const search = (extra: Record<string, unknown>) =>
    fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "search",
        operation: "search",
        query: "release",
        sort: "recent",
        ...extra,
      }),
    });
  expect((await search({ cursor: "cursor-1" })).status).toBe(200);
  expect(calls[0]).toMatchObject({ query: "release", sort: "recent", cursor: "cursor-1" });
  expect((await search({ cursor: "" })).status).toBe(400);
  expect((await search({ cursor: 7 })).status).toBe(400);
  expect((await search({ offset: -1 })).status).toBe(400);
  expect((await search({ offset: 1.5 })).status).toBe(400);
  expect((await search({ offset: 2 })).status).toBe(200);
  expect(calls).toHaveLength(2);
});

test("the search HTTP request carries the cursor and sort", async () => {
  let captured: URL | undefined;
  const client = createAgentMessageHttpClient(async (input) => {
    captured = input as URL;
    return Response.json({ protocolMajor: 1, requestId: "request-search", results: [] });
  });
  await client.requestSearch!({
    url: "https://server.example/api/agent/v1/messages",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
    request: {
      idempotencyKey: "request-search",
      workspaceId: "workspace-a",
      agentId: "agent-a",
      operation: "search",
      target: "",
      query: "release",
      sort: "recent",
      cursor: "cursor-1",
    },
  });
  expect(captured?.searchParams.get("cursor")).toBe("cursor-1");
  expect(captured?.searchParams.get("sort")).toBe("recent");
});

test("the search route's paging fields reach the transport shape", () => {
  expect(
    adaptAgentSearchResponse({
      idempotencyKey: "request-search",
      results: [hit],
      hasMore: true,
      nextCursor: "cursor-next",
      incomplete: true,
      searchedMessages: 5000,
      searchedThrough: "2026-08-01T00:00:00.000Z",
    }),
  ).toEqual({
    idempotencyKey: "request-search",
    accepted: true,
    attentionCount: 0,
    messages: [hit],
    hasMore: true,
    nextCursor: "cursor-next",
    incomplete: true,
    searchedMessages: 5000,
    searchedThrough: "2026-08-01T00:00:00.000Z",
  });
});

test("the runtime forwards a search cursor and returns the server's paging fields", async () => {
  const requests: unknown[] = [];
  const operations = new AgentMessageOperations({
    connection: { workspaceId: "workspace", computerId: "computer" },
    attention: new AgentMessageAttentionIndex(
      "workspace",
      {
        session: () => ({
          notify: async () => {},
          sendMessage: async () => {},
          subscribe: () => () => {},
          onExit: () => () => {},
          interrupt: async () => {},
          dispose: async () => {},
        }),
      },
      async () => {},
    ),
    isMemoryAgent: () => false,
    inbox: () => {
      throw new Error("not a send");
    },
    transport: {
      agentMessage: async (request) => {
        requests.push(request);
        return {
          idempotencyKey: request.idempotencyKey,
          accepted: true,
          attentionCount: 0,
          messages: [hit],
          hasMore: true,
          nextCursor: "cursor-2",
          incomplete: false,
        };
      },
    },
    reportFreshnessHold: () => {},
  });
  const response = await operations.handle(
    "agent-a",
    {
      idempotencyKey: "search",
      context: "context",
      operation: "search",
      query: "body",
      sort: "recent",
      cursor: "cursor-1",
    },
    undefined,
    "key",
  );
  expect(requests[0]).toMatchObject({ query: "body", sort: "recent", cursor: "cursor-1" });
  expect(response).toMatchObject({ hasMore: true, nextCursor: "cursor-2", incomplete: false });
});
