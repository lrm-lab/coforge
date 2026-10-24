import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

test("message search parses the lexical search options and dispatches them", async () => {
  expect(
    parseArgs([
      "message",
      "search",
      "--query",
      "release plan",
      "--target",
      "#general",
      "--sender",
      "@ada",
      "--sort",
      "recent",
      "--before",
      "2026-09-07T12:00:00Z",
      "--limit",
      "10",
      "--offset",
      "2",
    ]),
  ).toEqual({
    command: "search",
    query: "release plan",
    target: "#general",
    sender: "@ada",
    sort: "recent",
    before: "2026-09-07T12:00:00Z",
    limit: 10,
    offset: 2,
  });
  const calls: unknown[] = [];
  const output = await run(["message", "search", "--query", "release", "--limit", "5"], {
    check: async () => ({ messages: [] }),
    read: async () => undefined,
    search: async (options) => {
      calls.push(options);
      return {
        messages: [
          {
            id: "aaaaaaaa-0000-4000-8000-000000000001",
            sequence: 99,
            senderKind: "human",
            senderHandle: "ada",
            senderDescription: "",
            target: "#general",
            body: "release plan",
            createdAt: "2026-09-07T10:00:00Z",
          },
        ],
        hasMore: false,
      };
    },
    send: async () => undefined,
    view: async () => ({ bytes: new Uint8Array() }),
  });
  expect(calls).toEqual([{ query: "release", limit: 5 }]);
  expect(output).toContain("truncated=false");
  expect(output).toContain('<result ref="msg:aaaaaaaa-0000-4000-8000-000000000001">');
  expect(output).toContain("Source: #general");
  expect(output).toMatch(/Time: 2026-09-07 \d\d:\d\d:00 [+-]\d\d:\d\d\n/);
  expect(output).toContain("<match>release</match> plan");
  expect(output).not.toContain("sequence");
});

test("message search rejects empty searches and invalid options", () => {
  expect(() => parseArgs(["message", "search"])).toThrow("Usage:");
  expect(() => parseArgs(["message", "search", "--query", "x", "--sort", "oldest"])).toThrow(
    "Usage:",
  );
  expect(() => parseArgs(["message", "search", "--query", "x", "--offset", "-1"])).toThrow(
    "Usage:",
  );
});

test("message search --cursor continues a recent search with a query", () => {
  expect(
    parseArgs(["message", "search", "--query", "x", "--sort", "recent", "--cursor", "abc"]),
  ).toEqual({ command: "search", query: "x", sort: "recent", cursor: "abc" });
  const cursorUsage =
    "--cursor continues a recent search: pass a previous nextCursor with the same --query and --sort recent";
  expect(() => parseArgs(["message", "search", "--query", "x", "--cursor", "abc"])).toThrow(
    cursorUsage,
  );
  expect(() =>
    parseArgs(["message", "search", "--query", "x", "--sort", "relevance", "--cursor", "abc"]),
  ).toThrow(cursorUsage);
  expect(() =>
    parseArgs(["message", "search", "--sender", "ada", "--sort", "recent", "--cursor", "abc"]),
  ).toThrow(cursorUsage);
  expect(() =>
    parseArgs([
      "message",
      "search",
      "--query",
      "x",
      "--sort",
      "recent",
      "--cursor",
      "abc",
      "--offset",
      "2",
    ]),
  ).toThrow("--cursor already marks where to continue; drop --offset");
});
