import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAgentProxy } from "#src/agent-proxy";
import { LocalMemoryRuntime } from "#src/daemon-runtime/local-memory-runtime";

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))),
);

test("the authenticated memory endpoint persists to its Agent only and rejects identity overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-memory-proxy-"));
  roots.push(root);
  await Promise.all(
    ["agent-a", "agent-b"].map((agent) =>
      mkdir(join(root, "workspace/agents", agent), { recursive: true }),
    ),
  );
  const identities = new Map<string, string>();
  const memory = new LocalMemoryRuntime(
    (context) => {
      const agent = identities.get(context);
      if (!agent) throw new Error("unauthorized");
      return agent;
    },
    () => ({ workspaceRoot: root, workspaceId: "workspace" }),
  );
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => ({}),
      agentMemory: memory.execute.bind(memory),
      issueAgentContext: (agent, context) => {
        identities.set(context!, agent);
        return context!;
      },
    },
  });
  try {
    const a = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
    const b = proxy.issue("agent-b", `sk_agent_${"b".repeat(43)}`);
    const request = (token: string, body: unknown) =>
      fetch(new URL("/api/agent/v1/local-memory", proxy.url), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const command = {
      operation: "save",
      key: "domain",
      revision: "new",
      title: "Domain",
      content: "Already purchased",
      source: "user message",
      kind: "decision",
      applicability: "CoForge",
    };
    expect((await request(a, command)).status).toBe(200);
    expect((await request(b, { operation: "get", key: "domain" })).status).toBe(404);
    expect((await request(a, command)).status).toBe(409);
    expect((await request(a, { ...command, agentId: "agent-b" })).status).toBe(400);
    expect((await request("invalid", command)).status).toBe(401);
  } finally {
    proxy.close();
  }
});
