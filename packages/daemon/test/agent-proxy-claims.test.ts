import { afterEach, expect, test } from "bun:test";
import { startAgentProxy } from "#src/agent-proxy";
import { holdClaims } from "#src/daemon-runtime/response-claims";

const proxies: Array<{ close(): void }> = [];

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.close();
});

/** A proxy whose message handler answers with `messages` holding claims, counting their release. */
function setup(options: { bodyBytes?: number; delayMs?: number } = {}) {
  const released = { count: 0 };
  const proxy = startAgentProxy({
    runtime: {
      agentMessage: async () => {
        if (options.delayMs) await Bun.sleep(options.delayMs);
        const messages = [{ body: "x".repeat(options.bodyBytes ?? 10) }];
        holdClaims(messages, () => (released.count += 1));
        return { messages };
      },
    },
  });
  proxies.push(proxy);
  const token = proxy.issue("agent-a", `sk_agent_${"a".repeat(43)}`);
  const request = (signal?: AbortSignal) =>
    fetch(proxy.url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "k", operation: "read", target: "@ada" }),
      signal,
    });
  return { released, request };
}

test("a response the client read in full keeps its claims", async () => {
  const { released, request } = setup();
  const response = await request();
  expect(((await response.json()) as { messages: unknown[] }).messages).toHaveLength(1);
  await Bun.sleep(50);
  expect(released.count).toBe(0);
});

test("a client that goes away before the response is written gives its claims back", async () => {
  const { released, request } = setup({ delayMs: 200 });
  const controller = new AbortController();
  const pending = request(controller.signal).catch(() => undefined);
  await Bun.sleep(50);
  controller.abort();
  await pending;
  await Bun.sleep(400);
  expect(released.count).toBe(1);
});

test("a client that stops reading a large response gives its claims back, once", async () => {
  const { released, request } = setup({ bodyBytes: 20_000_000 });
  const response = await request();
  await response.body!.cancel();
  await Bun.sleep(300);
  expect(released.count).toBe(1);
});
