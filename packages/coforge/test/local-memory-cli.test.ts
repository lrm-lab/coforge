import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { parseMemoryArgs } from "#src/memory-commands";
import type { MessageTransport } from "#src/message-transport";

test("memory save requires evidence, defaults to a new local entry, and passes its scope", async () => {
  const invocation = parseArgs([
    "memory",
    "save",
    "--key",
    "preview-domain",
    "--title",
    "域名",
    "--content",
    "Already purchased",
    "--source",
    "user message 123",
    "--applicability",
    "staging",
  ]);
  expect(invocation).toMatchObject({
    command: "memory",
    request: { operation: "save", revision: "new", applicability: "staging" },
  });
  expect(() =>
    parseMemoryArgs([
      "save",
      "--key",
      "preview-domain",
      "--title",
      "domain",
      "--content",
      "purchased",
    ]),
  ).toThrow("source");
  const transport = { memory: async () => ({ entries: [] }) } as unknown as MessageTransport;
  expect(await run(["memory", "search", "--query", "domain"], transport)).toContain(
    "No matching local memory",
  );
});

test("memory refuses identity overrides, traversal, ambiguous flags and stale version shortcuts", () => {
  for (const args of [
    ["get", "--key", "../../other"],
    ["get", "--key", "safe", "--agentId", "neighbour"],
    ["search", "--query", "a", "--query", "b"],
    ["archive", "--key", "safe", "--revision", "latest"],
  ])
    expect(() => parseMemoryArgs(args)).toThrow();
});
