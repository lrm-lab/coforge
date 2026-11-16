import { expect, test } from "bun:test";
import { startAgentProxy } from "../src/agent-proxy";
import { connectLocal } from "../../coforge/src/local-client";

test("the shared CLI reaches memory through the token-bound daemon proxy without a provider-specific adapter", async () => {
  const seen: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        throw new Error("unexpected message call");
      },
      issueAgentContext: (agentId) => `context:${agentId}`,
      agentMemory: async (context, request, apiKey) => {
        expect(context).toBe("context:agent-a");
        expect(apiKey).toBe(`sk_agent_${"a".repeat(43)}`);
        seen.push(request);
        return { enabled: true, available: true, entries: [] };
      },
    },
  });
  try {
    const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
    const transport = connectLocal("", token, proxy.url);
    expect(await transport.memory({ operation: "search", query: "deployment" })).toEqual({
      enabled: true,
      available: true,
      entries: [],
    });
    expect(seen).toEqual([{ operation: "search", query: "deployment" }]);
    const url = new URL("/api/agent/v1/memory", proxy.url);
    const unauthorized = await fetch(url, {
      method: "POST",
      headers: { authorization: "Bearer invalid", "content-type": "application/json" },
      body: JSON.stringify({ operation: "list" }),
    });
    expect(unauthorized.status).toBe(401);
  } finally {
    proxy.close();
  }
});
