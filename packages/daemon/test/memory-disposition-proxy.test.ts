import { expect, test } from "bun:test";
import { startAgentProxy } from "../src/agent-proxy";

test("receipt proxy binds the agent context and blocks the Memory Agent fence", async () => {
  const calls: unknown[] = [];
  const proxy = startAgentProxy({
    runtime: {
      async agentMessage() {
        return {};
      },
      async agentMemoryDisposition(context, body, key) {
        calls.push({ context, body, key });
        return { ok: false, error: { code: "unauthorized" } };
      },
      memoryFence(agentId) {
        return agentId === "memory" ? "openviking-memory" : undefined;
      },
    },
  });
  try {
    const taskToken = proxy.issue("task", "sk_agent_" + "a".repeat(43));
    const memoryToken = proxy.issue("memory", "sk_agent_" + "b".repeat(43));
    const submit = (token: string) =>
      fetch(new URL("/api/agent/v1/memory-dispositions", proxy.url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hint_id: "hint", decision: "reject", reason: "unrelated" }),
      });
    const task = await submit(taskToken);
    expect(task.status).toBe(200);
    expect(await task.json()).toEqual({ ok: false, error: { code: "unauthorized" } });
    expect(calls).toHaveLength(1);
    const memory = await submit(memoryToken);
    expect(await memory.json()).toEqual({ ok: false, error: { code: "unauthorized" } });
    expect(calls).toHaveLength(1);
  } finally {
    proxy.close();
  }
});
