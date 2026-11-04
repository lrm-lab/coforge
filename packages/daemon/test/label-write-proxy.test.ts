import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const LABEL = {
  id: "lbl-1",
  name: "Defect",
  color: "error",
  description: "Something broken",
  groupId: null,
  archivedAt: null,
  group: null,
};

function labelsUrl(proxy: { url: string }) {
  return proxy.url.replace(
    agentApiRoutes.proxy.messages.path,
    agentApiRoutes.proxy.labelWrite.path,
  );
}

function start(calls: unknown[]) {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      agentLabel: async (context, request) => {
        calls.push({ context, request });
        return Response.json({ ok: true, label: LABEL });
      },
    },
  });
  proxies.push(proxy);
  return { proxy, token: proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`) };
}

/** `coforge label rename|update|delete|restore|create` through the daemon (task #508): the proxy
 * checks the body is one label write and forwards it, answering the cloud's response as it came. */
test("the proxy hands a label write to the runtime and answers its response", async () => {
  const calls: unknown[] = [];
  const { proxy, token } = start(calls);
  const request = { operation: "update", label: "Bug", name: "Defect" };
  const response = await fetch(labelsUrl(proxy), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, label: LABEL });
  expect(calls).toEqual([{ context: "agent-a", request }]);
});

test("a body that is not one label write never reaches the runtime", async () => {
  const calls: unknown[] = [];
  const { proxy, token } = start(calls);
  const response = await fetch(labelsUrl(proxy), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ operation: "update", label: "Bug" }),
  });
  expect(response.status).toBe(400);
  expect(calls).toEqual([]);
});

test("the label list still answers GET on the same path", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      labelList: async () => ({ ok: true as const, labels: [] }),
      agentLabel: async () => Response.json({ ok: true, label: LABEL }),
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(labelsUrl(proxy), { headers: { authorization: `Bearer ${token}` } });
  expect(await response.json()).toEqual({ ok: true, labels: [] });
});
