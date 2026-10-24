import { afterEach, expect, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";

afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore();
});

const context = `sfp_${"a".repeat(43)}`;
const proxy = `http://127.0.0.1:1${agentApiRoutes.local.messages.path}`;

test("mention pending sends the limit as a query parameter, and none when it has no limit", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({
      ok: true,
      pendingMentionActions: [],
      hasMore: true,
    })) as unknown as typeof globalThis.fetch);
  const client = connectLocal("", context, proxy);
  expect(await client.mentionPending(7)).toEqual({
    ok: true,
    pendingMentionActions: [],
    hasMore: true,
  });
  await client.mentionPending();
  const [limited, plain] = fetch.mock.calls.map(([url]) => String(url));
  expect(limited).toBe(
    `http://127.0.0.1:1${agentApiRoutes.local.mentionActions.pending.path}?limit=7`,
  );
  expect(plain).toBe(`http://127.0.0.1:1${agentApiRoutes.local.mentionActions.pending.path}`);
});

test("thread list GETs the followed threads through the Proxy and names a failure THREAD_LIST_FAILED", async () => {
  const body = { ok: true as const, threads: [] };
  const fetch = spyOn(globalThis, "fetch")
    .mockImplementationOnce((async () => Response.json(body)) as unknown as typeof globalThis.fetch)
    .mockImplementationOnce(
      (async () => new Response("nope", { status: 403 })) as unknown as typeof globalThis.fetch,
    );
  const client = connectLocal("", context, proxy);
  expect(await client.threadList()).toEqual(body);
  const [url, init] = fetch.mock.calls[0]!;
  expect(String(url)).toBe(`http://127.0.0.1:1${agentApiRoutes.local.threadList.path}`);
  expect(init?.method).toBe("GET");
  const failure = (await client.threadList().catch((caught: unknown) => caught)) as {
    code: string;
  };
  expect(failure.code).toBe("THREAD_LIST_FAILED");
});
