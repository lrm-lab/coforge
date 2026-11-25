import { expect, test } from "bun:test";
import { getJsonLinesFormatter } from "@logtape/logtape";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { startAgentProxy } from "#src/agent-proxy";
import { captureDaemonLogs } from "./log-capture";

test("proxy request logs use only the registered Agent identity", async () => {
  const keyA = `sk_agent_${"a".repeat(43)}`;
  const keyB = `sk_agent_${"b".repeat(43)}`;
  const unknownToken = `sfp_${"z".repeat(43)}`;
  const { messages, inboxRead } = agentApiRoutes.proxy;
  const calls: unknown[] = [];

  const { records, result: tokens } = await captureDaemonLogs(async () => {
    let running = true;
    const proxy = startAgentProxy({
      runtime: {
        issueAgentContext: (agentId) => agentId,
        isAgentSessionRunning: () => running,
        agentMessage: async (context, request, key) => {
          calls.push({ context, operation: request.operation, keyIsA: key === keyA });
          return { ok: true };
        },
      },
    });
    try {
      const tokenA = proxy.issue("agent-a", keyA);
      const tokenB = proxy.issue("agent-b", keyB);
      const request = (path: string, authorization?: string) =>
        fetch(new URL(path, proxy.url), {
          headers: authorization ? { authorization: `Bearer ${authorization}` } : {},
        });

      const response = await fetch(new URL(`${messages.path}?agent_id=query-id`, proxy.url), {
        method: messages.method,
        headers: {
          authorization: `Bearer ${tokenA}`,
          "content-type": "application/json",
          "x-agent-id": "header-id",
        },
        body: JSON.stringify({
          operation: "read",
          idempotencyKey: "fixture-request",
          target: "@fixture",
          agent_id: "body-id",
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await request(inboxRead.path, tokenB)).status).toBe(400);
      expect((await request("/missing", tokenA)).status).toBe(404);

      running = false;
      expect((await request(inboxRead.path, tokenB)).status).toBe(409);
      running = true;
      expect((await request(inboxRead.path)).status).toBe(401);
      expect((await request(inboxRead.path, "bad-token")).status).toBe(401);
      expect((await request(inboxRead.path, unknownToken)).status).toBe(401);
      proxy.revoke(tokenB);
      expect((await request(inboxRead.path, tokenB)).status).toBe(401);
      return [tokenA, tokenB];
    } finally {
      proxy.close();
    }
  });

  expect(calls).toEqual([{ context: "agent-a", operation: "read", keyIsA: true }]);
  const requests = records.filter((record) => record.properties.event === "agent.proxy.request");
  expect(requests.map(({ level, properties }) => ({ level, ...properties }))).toEqual(
    [
      [messages.method, messages.path, "agent-a"],
      [inboxRead.method, inboxRead.path, "agent-b"],
      ["GET", "/missing", "agent-a"],
      [inboxRead.method, inboxRead.path, "agent-b"],
      ...Array.from({ length: 4 }, () => [inboxRead.method, inboxRead.path]),
    ].map(([method, path, agentId]) => ({
      level: "info",
      event: "agent.proxy.request",
      method,
      path,
      ...(agentId ? { agent_id: agentId } : {}),
    })),
  );

  const format = getJsonLinesFormatter({ properties: "flatten" });
  const jsonl = requests.map(format).join("");
  for (const value of [
    ...tokens,
    keyA,
    keyB,
    unknownToken,
    "bad-token",
    "query-id",
    "header-id",
    "body-id",
  ]) {
    expect(jsonl).not.toContain(value);
  }
});
