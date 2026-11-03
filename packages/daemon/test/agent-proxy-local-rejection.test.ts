import { afterEach, expect, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import type { AgentProxyFailureBody } from "#src/agent-proxy-failure";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

test("the proxy's own validation reject is a local precondition, not an upstream 5xx", async () => {
  const proxy = startAgentProxy({
    runtime: { agentMessage: async () => ({}), agentTask: async () => ({}) },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const response = await fetch(
    proxy.url.replace(agentApiRoutes.proxy.messages.path, agentApiRoutes.proxy.tasks.path),
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        idempotencyKey: "task",
        operation: "amend",
        target: "#general",
        number: 14,
      }),
    },
  );
  expect(response.status).toBe(400);
  const body = (await response.json()) as AgentProxyFailureBody;
  expect(body).toMatchObject({
    // The caller's own validation message travels unchanged.
    error: "missing Task operation argument",
    code: "INVALID_INPUT",
    retryable: false,
    proxy: {
      layer: "local_daemon_proxy",
      failure_class: "local_precondition",
      cause_code: "INVALID_INPUT",
      response_started: false,
    },
  });
});
