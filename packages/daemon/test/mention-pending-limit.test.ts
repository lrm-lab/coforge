import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { createAgentMessageHttpClient } from "#src/connection/agent-http-clients";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const PENDING = { ok: true as const, pendingMentionActions: [], hasMore: false };

async function askProxy(search: string) {
  const requests: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      mentionPending: async (_context, request) => {
        requests.push(request);
        return PENDING;
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(
      agentApiRoutes.proxy.messages.path,
      agentApiRoutes.proxy.mentionActions.pending.path,
    ) + search,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { response, requests };
}

test("the proxy hands a valid limit to the runtime", async () => {
  const { response, requests } = await askProxy("?limit=7");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(PENDING);
  expect(requests).toEqual([{ limit: 7 }]);
});

test("the proxy refuses a limit that is not a whole number from 1 to 100 before any request", async () => {
  for (const search of ["?limit=0", "?limit=101", "?limit=x", "?limit=2.5", "?limit="]) {
    const { response, requests } = await askProxy(search);
    expect(response.status).toBe(400);
    expect(requests).toEqual([]);
  }
});

test("the HTTP transport sends the limit to the server, and none when the CLI sent none", async () => {
  const urls: string[] = [];
  const client = createAgentMessageHttpClient(async (input) => {
    urls.push(String(input));
    return Response.json(PENDING);
  });
  const keys = {
    url: "https://server.example/api/agent/v1/mention-actions/pending",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
  };
  await client.requestMentionPending!({ ...keys, request: { limit: 7 } });
  await client.requestMentionPending!({ ...keys, request: {} });
  expect(urls).toEqual([`${keys.url}?limit=7`, keys.url]);
});

test("the proxy forwards thread list to the runtime and the HTTP transport GETs the threads route", async () => {
  const requests: unknown[] = [];
  const response = { ok: true as const, threads: [] };
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      threadList: async (context, request) => {
        requests.push({ context, request });
        return response;
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const answered = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.threadList.path),
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(answered.status).toBe(200);
  expect(await answered.json()).toEqual(response);
  expect(requests).toEqual([{ context: "agent-a", request: {} }]);

  const calls: Array<{ url: string; method?: string }> = [];
  const client = createAgentMessageHttpClient(async (input, init) => {
    calls.push({ url: String(input), method: init?.method });
    return Response.json(response);
  });
  const url = "https://server.example/api/agent/v1/threads";
  expect(
    await client.requestThreadList!({
      url,
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: {},
    }),
  ).toEqual(response);
  expect(calls).toEqual([{ url, method: "GET" }]);
});
