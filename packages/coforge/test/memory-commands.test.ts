import { expect, test } from "bun:test";
import { parseMemoryArgs, runMemoryCommand } from "../src/memory-commands";
test("runtime-neutral memory search and explicit private/team writes", () => {
  expect(
    parseMemoryArgs(["search", "--query", "release requirements", "--scope", "team"]).request,
  ).toEqual({ operation: "search", query: "release requirements", scope: "team" });
  const result = parseMemoryArgs([
    "create",
    "--title",
    "Rule",
    "--content",
    "Run tests",
    "--kind",
    "fact",
  ]);
  expect(result.request.operation).toBe("create");
  expect("scope" in result.request && result.request.scope).toBe("agent");
  expect(() => parseMemoryArgs(["delete", "--id", "123"])).toThrow();
  expect(() => parseMemoryArgs(["search", "--query", "x", "--query", "y"])).toThrow();
});

test("paged memory indexes omit bodies and retain IDs, lengths and pagination for progressive reads", async () => {
  const entry = {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 2,
    scope: "team" as const,
    agentId: null,
    kind: "experience" as const,
    title: "Release procedure",
    content: "Full memory body stays out of the directory. ".repeat(300),
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
  };
  for (const operation of ["list", "search"] as const) {
    const args =
      operation === "list"
        ? ["list", "--page", "2", "--index"]
        : ["search", "--query", "release", "--index"];
    const output = await runMemoryCommand(args, async (request) => {
      expect(request.operation).toBe(operation);
      expect(request).not.toHaveProperty("index");
      return { enabled: true, available: true, entries: [entry], page: 2, pageCount: 3 };
    });
    const result = JSON.parse(output);
    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(3);
    expect(result.entries[0]).toMatchObject({
      id: entry.id,
      title: entry.title,
      revision: 2,
      contentChars: entry.content.length,
    });
    expect(result.entries[0]).not.toHaveProperty("content");
    expect(output).not.toContain("Full memory body");
  }
  const full = await runMemoryCommand(["get", "--id", entry.id], async () => ({
    enabled: true,
    available: true,
    entries: [entry],
  }));
  expect(JSON.parse(full).entries[0].content).toBe(entry.content);
  expect(() => parseMemoryArgs(["get", "--id", entry.id, "--index"])).toThrow();
});

test("an option value literally named --index does not switch output to a directory", async () => {
  for (const args of [
    ["search", "--query", "--index"],
    ["create", "--title", "Literal option", "--content", "--index"],
  ]) {
    const output = await runMemoryCommand(args, async () => ({
      enabled: true,
      available: true,
      entries: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          revision: 1,
          scope: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          kind: "fact",
          title: "Literal option",
          content: "--index",
          createdAt: "2026-11-16T00:00:00.000Z",
          updatedAt: "2026-11-16T00:00:00.000Z",
        },
      ],
    }));
    expect(JSON.parse(output).entries[0].content).toBe("--index");
  }
});
