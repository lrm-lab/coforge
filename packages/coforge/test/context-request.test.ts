import { expect, test } from "bun:test";
import { contextQueryRequest } from "#src/local-readonly-requests";

test("context proxy requests use the daemon's snake_case query contract", async () => {
  const previous = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input) => {
    url = String(input);
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "search",
        messageId: "message-1",
        sessionId: "session-1",
        query: "deploy",
        total: 0,
        offset: 0,
        limit: 20,
        results: [],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    await contextQueryRequest(
      (path) => new URL(`http://127.0.0.1${path}`),
      `sfp_${"a".repeat(43)}`,
      "http://127.0.0.1:1234",
      { mode: "search", messageId: "message-1", sessionId: "session-1", query: "deploy" },
    );
  } finally {
    globalThis.fetch = previous;
  }
  expect(url).toContain("message_id=message-1");
  expect(url).toContain("session_id=session-1");
  expect(url).not.toContain("messageId");
  expect(url).not.toContain("sessionId");
});
