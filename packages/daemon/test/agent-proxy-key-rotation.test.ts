import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { agentHeaders } from "#src/connection/agent-http-wire";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

const K1 = `sk_agent_${"a".repeat(43)}`;
const K2 = `sk_agent_${"b".repeat(43)}`;

function workspaceUrl(proxy: { url: string }) {
  return proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.workspace.path);
}

function setup(agentApiKeys: Map<string, string>) {
  const forwarded: Array<string | undefined> = [];
  const proxy = startAgentProxy({
    agentApiKeys,
    runtime: {
      agentMessage: async () => ({}),
      issueAgentContext: (agentId: string) => agentId,
      workspaceInfo: async (_context, _request, agentApiKey) => {
        forwarded.push(agentApiKey);
        return {
          idempotencyKey: "",
          workspace: undefined as never,
          humans: [],
          agents: [],
          projects: [],
        };
      },
    },
  });
  proxies.push(proxy);
  const request = (token: string) =>
    fetch(workspaceUrl(proxy), { headers: { authorization: `Bearer ${token}` } });
  return { forwarded, proxy, request };
}

/** The bug this fixes: `issue` baked the launch-time key into the token binding, so a key minted
 * by a later launch never reached a running process. The binding now resolves the registry's
 * current key at request time. */
test("a proxy binding forwards the registry's current key after a rotation", async () => {
  const agentApiKeys = new Map<string, string>();
  const { forwarded, proxy, request } = setup(agentApiKeys);
  const token = proxy.issue("agent-a", K1);

  expect((await request(token)).status).toBe(200);
  expect(forwarded).toEqual([K1]);

  agentApiKeys.set("agent-a", K2);
  expect((await request(token)).status).toBe(200);
  expect(forwarded).toEqual([K1, K2]);
});

test("a binding whose Agent left the registry gets no key", async () => {
  const agentApiKeys = new Map<string, string>();
  const { forwarded, proxy, request } = setup(agentApiKeys);
  const token = proxy.issue("agent-a", K1);
  agentApiKeys.delete("agent-a");

  expect((await request(token)).status).toBe(200);
  expect(forwarded).toEqual([undefined]);
});

test("forwarded Agent HTTPS requests carry an x-request-id correlation header", () => {
  const headers = agentHeaders({ agentApiKey: K1, daemonApiKey: "dk_x" });
  expect(headers["x-request-id"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});
