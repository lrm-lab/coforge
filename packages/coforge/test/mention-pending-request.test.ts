import { afterEach, expect, spyOn, test } from "bun:test";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { connectLocal } from "#src/local-client";

afterEach(() => {
  spyOn(globalThis, "fetch").mockRestore();
});

const context = `sfp_${"a".repeat(43)}`;
const proxy = `http://127.0.0.1:1${agentApiRoutes.local.messages.path}`;

test("mention pending sends the limit as a query parameter, and none when it has no limit", async () => {
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ ok: true, pendingMentionActions: [], hasMore: true }),
  );
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
