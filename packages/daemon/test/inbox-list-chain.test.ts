import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { createAgentMessageHttpClient } from "#src/connection/agent-http-clients";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const LIST = {
  ok: true as const,
  view: "unread" as const,
  items: [],
  totals: { conversations: 0, dms: 0, mentions: 0 },
  hasMore: false,
  nextBefore: null,
};

async function askProxy(search: string) {
  const requests: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      inboxList: async (_context, request) => {
        requests.push(request);
        return LIST;
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.inboxList.path) +
      search,
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { response, requests };
}

test("the proxy hands a valid view and before to the runtime", async () => {
  const { response, requests } = await askProxy("?view=mentions&before=42");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(LIST);
  expect(requests).toEqual([{ view: "mentions", before: 42 }]);
});

test("the proxy refuses a bad view or before before any request", async () => {
  for (const search of ["?view=all", "?before=0", "?before=x", "?before=1.5"]) {
    const { response, requests } = await askProxy(search);
    expect(response.status).toBe(400);
    expect(requests).toEqual([]);
  }
});

test("the HTTP transport sends view and before, and none when the CLI sent none", async () => {
  const urls: string[] = [];
  const client = createAgentMessageHttpClient(async (input) => {
    urls.push(String(input));
    return Response.json(LIST);
  });
  const keys = {
    url: "https://server.example/api/agent/v1/inbox/conversations",
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
  };
  await client.requestInboxList!({ ...keys, request: { view: "mentions", before: 42 } });
  await client.requestInboxList!({ ...keys, request: {} });
  expect(urls).toEqual([`${keys.url}?view=mentions&before=42`, keys.url]);
});
