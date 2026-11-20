import { expect, test } from "bun:test";
import { parseArgs, run } from "../index";
import { parseMemoryArgs, runMemoryCommand } from "#src/memory-commands";
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

test("local listing preserves the archive filter and provides executable continuation and full-entry commands", async () => {
  const requests: unknown[] = [];
  const transport = {
    memory: async (request: unknown) => {
      requests.push(request);
      return {
        entries: [
          {
            key: "decision",
            title: "Decision",
            content: "preview",
            source: "human",
            applicability: "staging",
            revision: "a".repeat(64),
            status: "archived",
            kind: "decision",
            updatedAt: "2026-11-17T00:00:00Z",
            path: "notes/knowledge/decision.md",
          },
        ],
        incomplete: true,
        nextOffset: 15,
      };
    },
  } as unknown as MessageTransport;
  const output = await run(["memory", "list", "--archived", "--offset", "10"], transport);
  expect(requests).toEqual([{ operation: "list", archived: true, offset: 10 }]);
  expect(output).toContain("coforge memory get --key decision");
  expect(output).toContain("coforge memory list --archived --offset 15");
  for (const args of [
    ["list", "--query", "x"],
    ["list", "--archived", "--archived"],
    ["list", "--offset", "-1"],
  ])
    expect(() => parseMemoryArgs(args)).toThrow();
});

test("personal memory search can explicitly include archives and keeps that filter in continuation", async () => {
  const invocation = parseMemoryArgs(["search", "--query", "domain", "--archived"]);
  expect(invocation).toMatchObject({
    request: { operation: "search", query: "domain", archived: true },
  });
  const output = await runMemoryCommand(invocation, {
    memory: async () => ({ entries: [], nextOffset: 128 }),
  });
  expect(output).toContain("--archived --offset 128");
});

test.each([
  ["--body", "Use --content"],
  ["--summary", "Use --title and --content"],
  ["--file", "Pass the text with --content"],
])("memory save explains unsupported %s without accepting it", (flag, hint) => {
  expect(() => parseMemoryArgs(["save", "--key", "lesson", flag, "private-value"])).toThrow(hint);
  expect(() => parseMemoryArgs(["save", "--key", "lesson", flag, "private-value"])).not.toThrow(
    "private-value",
  );
});
