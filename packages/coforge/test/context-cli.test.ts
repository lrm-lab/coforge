import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";

test("context search/read parse their scoped arguments", () => {
  expect(
    parseArgs([
      "context",
      "search",
      "--message-id",
      "message-1",
      "--session-id",
      "session-1",
      "--query",
      "deploy",
      "--limit",
      "5",
    ]),
  ).toMatchObject({ command: "context-search", limit: 5 });
  expect(
    parseArgs([
      "context",
      "read",
      "--message-id",
      "message-1",
      "--session-id",
      "session-1",
      "--around",
      "m0.p0",
    ]),
  ).toMatchObject({ command: "context-read" });
});

test("context parsing rejects unknown and repeated flags", () => {
  expect(() =>
    parseArgs([
      "context",
      "search",
      "--message-id",
      "m",
      "--session-id",
      "s",
      "--query",
      "q",
      "--wat",
      "1",
    ]),
  ).toThrow("unknown or repeated flag");
  expect(() =>
    parseArgs([
      "context",
      "read",
      "--message-id",
      "m",
      "--message-id",
      "m2",
      "--session-id",
      "s",
      "--around",
      "m0.p0",
    ]),
  ).toThrow("unknown or repeated flag");
});

test("context commands use the corresponding transport", async () => {
  const calls: string[] = [];
  const transport = {
    contextSearch: async () => {
      calls.push("search");
      return { ok: true, mode: "search" };
    },
    contextRead: async () => {
      calls.push("read");
      return { ok: true, mode: "read" };
    },
  } as never;
  await run(
    ["context", "search", "--message-id", "m", "--session-id", "s", "--query", "q"],
    transport,
  );
  await run(
    ["context", "read", "--message-id", "m", "--session-id", "s", "--around", "m0.p0"],
    transport,
  );
  expect(calls).toEqual(["search", "read"]);
});
