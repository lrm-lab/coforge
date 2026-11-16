import { expect, test } from "bun:test";
import { parseMemoryArgs } from "../src/memory-commands";
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
