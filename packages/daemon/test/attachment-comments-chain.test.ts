import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { createAgentMessageHttpClient } from "#src/connection/agent-http-clients";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const ID = "9f0c5a52-1111-4222-8333-444455556666";
const PAGE = {
  ok: true as const,
  attachmentId: ID,
  viewer: {
    canComment: true,
    canResolve: true,
    resolveAction: { type: "reaction" as const, emoji: "✅" as const },
  },
  comments: [],
  hasOlder: false,
};

async function askProxy(attachmentId: string, search: string, failure?: unknown) {
  const requests: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      attachmentComments: async (_context, request) => {
        requests.push(request);
        if (failure) throw failure;
        return PAGE;
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const base = proxy.url.replace(
    agentApiRoutes.proxy.messages.path,
    agentApiRoutes.proxy.attachmentComments.path(attachmentId),
  );
  const response = await fetch(base + search, { headers: { authorization: `Bearer ${token}` } });
  return { response, requests };
}

test("the proxy hands the id, limit and before to the runtime", async () => {
  const { response, requests } = await askProxy(ID, "?limit=5&before=42");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(PAGE);
  expect(requests).toEqual([{ attachmentId: ID, limit: 5, before: 42 }]);
});

test("the proxy refuses a bad id, limit or before before any request", async () => {
  for (const [id, search] of [
    ["not-a-uuid", ""],
    [ID, "?limit=0"],
    [ID, "?limit=101"],
    [ID, "?limit=x"],
    [ID, "?before=0"],
    [ID, "?before=1.5"],
  ] as const) {
    const { response, requests } = await askProxy(id, search);
    expect(response.status).toBe(400);
    expect(requests).toEqual([]);
  }
});

test("the HTTP transport sends limit and before, and none when the CLI sent none", async () => {
  const urls: string[] = [];
  const client = createAgentMessageHttpClient(async (input) => {
    urls.push(String(input));
    return Response.json(PAGE);
  });
  const keys = {
    url: `https://server.example/api/agent/v1/attachments/${ID}/comments`,
    agentApiKey: `sk_agent_${"a".repeat(43)}`,
    daemonApiKey: "daemon-token",
  };
  await client.requestAttachmentComments!({
    ...keys,
    request: { attachmentId: ID, limit: 5, before: 42 },
  });
  await client.requestAttachmentComments!({ ...keys, request: { attachmentId: ID } });
  expect(urls).toEqual([`${keys.url}?limit=5&before=42`, keys.url]);
});

test("the HTTP transport turns a NOT_FOUND envelope into a typed error", async () => {
  const client = createAgentMessageHttpClient(async () =>
    Response.json({ ok: false, errorCode: "NOT_FOUND", error: "nope" }, { status: 404 }),
  );
  await expect(
    client.requestAttachmentComments!({
      url: `https://server.example/api/agent/v1/attachments/${ID}/comments`,
      agentApiKey: `sk_agent_${"a".repeat(43)}`,
      daemonApiKey: "daemon-token",
      request: { attachmentId: ID },
    }),
  ).rejects.toMatchObject({ errorCode: "NOT_FOUND" });
});
