import { expect, test } from "bun:test";
import { readContextView, searchContextView } from "#src/agent-context-view/context-view-entries";
import type { RestoredContextView } from "#src/agent-context-view/context-view-restore";

const view: RestoredContextView = {
  runtime: "claude-code",
  sessionId: "session-1",
  messageId: "message-1",
  system: [{ text: "system rule" }],
  tools: [{ name: "shell", description: "run a command", inputSchema: { type: "object" } }],
  messages: [
    { role: "user", parts: [{ kind: "text", text: "Please inspect the deploy logs" }] },
    { role: "assistant", parts: [{ kind: "text", text: "I will inspect the deploy logs." }] },
  ],
  source: { kind: "native", format: "jsonl" },
  redactions: { media: 0, diagnostic: 0 },
};

test("search returns stable entry ids and bounded snippets", () => {
  const result = searchContextView(view, {
    messageId: "message-1",
    sessionId: "session-1",
    query: "deploy",
  });
  expect(result.total).toBe(2);
  expect(result.results.map((entry) => entry.id)).toEqual(["m0.p0", "m1.p0"]);
  expect(result.results[0]?.snippet).toContain("deploy");
});

test("read returns a bounded window around an entry", () => {
  const result = readContextView(view, {
    messageId: "message-1",
    sessionId: "session-1",
    around: "m1.p0",
    limit: 3,
  });
  expect(result.entries.map((entry) => entry.id)).toEqual(["m0.p0", "m1.p0"]);
  expect(result.hasMore).toBe(false);
});

test("search omits full matching bodies and read truncates oversized entries", () => {
  const large: RestoredContextView = {
    ...view,
    messages: [{ role: "user", parts: [{ kind: "text", text: "deploy".repeat(20_000) }] }],
  };
  const search = searchContextView(large, {
    messageId: "message-1",
    sessionId: "session-1",
    query: "deploy",
  });
  expect(search.results[0]).not.toHaveProperty("text");
  const read = readContextView(large, {
    messageId: "message-1",
    sessionId: "session-1",
    around: "m0.p0",
    limit: 1,
  });
  expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(8 * 1024);
  expect(read.hasMore).toBe(true);
});
