import { describe, expect, test } from "bun:test";

import {
  AGENT_NAME_MAX_LENGTH,
  AGENT_NAME_PATTERN,
  deletedAgentName,
  freeAgentName,
  suffixedAgentName,
} from "./agent-name";

describe("suffixedAgentName", () => {
  test("cuts the name, never the suffix, and stays a valid name", () => {
    const long = `${"a".repeat(AGENT_NAME_MAX_LENGTH - 3)}-bc`;
    const name = suffixedAgentName(long, "-2");
    expect(name).toBe(`${"a".repeat(AGENT_NAME_MAX_LENGTH - 3)}-2`);
    expect(name.length).toBeLessThanOrEqual(AGENT_NAME_MAX_LENGTH);
    expect(name).toMatch(AGENT_NAME_PATTERN);
  });
});

describe("freeAgentName", () => {
  test("keeps a name nobody has", () => {
    expect(freeAgentName("coforge", new Set(["other"]))).toBe("coforge");
  });
  test("steps past taken names, compared without case", () => {
    expect(freeAgentName("Coforge", new Set(["coforge", "coforge-2"]))).toBe("Coforge-3");
    const long = "a".repeat(AGENT_NAME_MAX_LENGTH);
    expect(freeAgentName(long, new Set([long]))).toBe(`${"a".repeat(AGENT_NAME_MAX_LENGTH - 2)}-2`);
  });
});

describe("deletedAgentName", () => {
  test("frees the name with the id's first 12 hex digits, within the bound", () => {
    const id = "0191f2a4-7b3c-7d8e-9f01-23456789abcd";
    expect(deletedAgentName("ada", id)).toBe("ada-deleted-0191f2a47b3c");
    const freed = deletedAgentName("a".repeat(AGENT_NAME_MAX_LENGTH), id);
    expect(freed.length).toBe(AGENT_NAME_MAX_LENGTH);
    expect(freed).toMatch(AGENT_NAME_PATTERN);
  });
});
