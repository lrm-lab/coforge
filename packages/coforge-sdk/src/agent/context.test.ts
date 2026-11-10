import { expect, test } from "bun:test";
import { decodeAgentContextQueryResponse } from "./context";

test("context response decoding rejects malformed nested results", () => {
  expect(() =>
    decodeAgentContextQueryResponse({
      ok: true,
      mode: "search",
      messageId: "message-1",
      sessionId: "session-1",
      query: "deploy",
      total: 1,
      offset: 0,
      limit: 20,
      results: [{ id: "m0.p0", kind: "message", text: "raw body" }],
    }),
  ).toThrow("invalid Agent context search response");
});

test("context response decoding accepts bounded search results", () => {
  expect(
    decodeAgentContextQueryResponse({
      ok: true,
      mode: "search",
      messageId: "message-1",
      sessionId: "session-1",
      query: "deploy",
      total: 1,
      offset: 0,
      limit: 20,
      results: [{ id: "m0.p0", kind: "message", snippet: "deploy" }],
    }),
  ).toMatchObject({ ok: true, mode: "search" });
});
