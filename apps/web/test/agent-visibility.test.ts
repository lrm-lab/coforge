import { describe, expect, test } from "bun:test";

import {
  AGENT_VISIBILITY,
  AGENT_VISIBILITY_VALUES,
  isAgentVisibility,
  normalizeAgentVisibility,
} from "#src/features/agents/agent-visibility";

describe("AGENT_VISIBILITY", () => {
  test("has exactly public and private", () => {
    expect(AGENT_VISIBILITY).toEqual({ PUBLIC: "public", PRIVATE: "private" });
    expect(AGENT_VISIBILITY_VALUES).toEqual(["public", "private"]);
  });

  test("isAgentVisibility recognizes only the two declared values", () => {
    expect(isAgentVisibility("public")).toBeTrue();
    expect(isAgentVisibility("private")).toBeTrue();
    expect(isAgentVisibility("PUBLIC")).toBeFalse();
    expect(isAgentVisibility("")).toBeFalse();
    expect(isAgentVisibility("hidden")).toBeFalse();
  });

  test("normalizeAgentVisibility reads anything but exactly public as private", () => {
    expect(normalizeAgentVisibility("public")).toBe("public");
    expect(normalizeAgentVisibility("private")).toBe("private");
    expect(normalizeAgentVisibility("PUBLIC")).toBe("private");
    expect(normalizeAgentVisibility("hidden")).toBe("private");
    expect(normalizeAgentVisibility("")).toBe("private");
    expect(normalizeAgentVisibility(undefined)).toBe("private");
  });
});
