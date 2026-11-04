import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const LIST = { ok: true as const, labels: [] };

function labelsUrl(proxy: { url: string }) {
  return proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.labels.path);
}

/** `coforge label list` through the daemon: the local proxy admits the labels route and hands it
 * to the runtime, which forwards to the cloud with the Agent's credentials. */
test("the proxy hands the label list to the runtime and answers its response", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      labelList: async (context, request) => {
        calls.push({ context, request });
        return LIST;
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(labelsUrl(proxy), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(LIST);
  expect(calls).toEqual([{ context: "agent-a", request: {} }]);
});

test("the labels route 404s without its runtime handler", async () => {
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(labelsUrl(proxy), {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(404);
});
