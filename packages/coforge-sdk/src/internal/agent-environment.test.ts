import { describe, expect, test } from "bun:test";
import {
  AGENT_ENVIRONMENT_MAX_NAME_LENGTH,
  AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH,
  AGENT_ENVIRONMENT_MAX_VALUE_LENGTH,
  AGENT_ENVIRONMENT_MAX_VARIABLES,
  AGENT_ENVIRONMENT_NAME_PATTERN,
  AGENT_ENVIRONMENT_RESERVED_NAMES,
  AGENT_ENVIRONMENT_RESERVED_PREFIXES,
  agentEnvironmentNameViolation,
  agentEnvironmentShapeViolation,
  agentEnvironmentViolation,
  isReservedAgentEnvironmentName,
  launchUnsafeAgentEnvironmentNames,
} from "./agent-environment";

describe("agent environment limits", () => {
  test("pins the values both edges enforce", () => {
    expect(AGENT_ENVIRONMENT_MAX_VARIABLES).toBe(64);
    expect(AGENT_ENVIRONMENT_MAX_NAME_LENGTH).toBe(128);
    expect(AGENT_ENVIRONMENT_MAX_VALUE_LENGTH).toBe(32_768);
    expect(AGENT_ENVIRONMENT_MAX_SERIALIZED_LENGTH).toBe(131_072);
  });

  test("accepts shell-identifier names and refuses anything else", () => {
    for (const name of ["A", "_", "A_1", "aBc9_", "_x"]) {
      expect(AGENT_ENVIRONMENT_NAME_PATTERN.test(name)).toBe(true);
    }
    for (const name of ["", "1A", "A-B", "A.B", "A B", "A=B", "Ä"]) {
      expect(AGENT_ENVIRONMENT_NAME_PATTERN.test(name)).toBe(false);
    }
  });

  test("reserves every name the runtime policy refuses, case-insensitively", () => {
    for (const name of AGENT_ENVIRONMENT_RESERVED_NAMES) {
      expect(isReservedAgentEnvironmentName(name)).toBe(true);
      expect(isReservedAgentEnvironmentName(name.toLowerCase())).toBe(true);
    }
    // Names that make the runtime's own shell or toolchain execute something else.
    for (const name of ["Node_Options", "dyld_insert_libraries", "bash_env", "git_ssh_command"])
      expect(isReservedAgentEnvironmentName(name)).toBe(true);
  });

  test("reserves the prefixes whose suffix is the variable, case-insensitively", () => {
    for (const prefix of AGENT_ENVIRONMENT_RESERVED_PREFIXES) {
      expect(isReservedAgentEnvironmentName(`${prefix}suffix`)).toBe(true);
      expect(isReservedAgentEnvironmentName(`${prefix.toLowerCase()}suffix`)).toBe(true);
    }
  });

  test("leaves ordinary names alone, including near-misses of a reserved one", () => {
    for (const name of [
      "PATHX",
      "XCOFORGE_Y",
      "LDX_PRELOAD",
      "HOMEDRIVEX",
      "SHELLX",
      "OPENROUTER_API_KEY",
      "MY_VAR",
      "HOMES",
    ])
      expect(isReservedAgentEnvironmentName(name)).toBe(false);
  });

  test("names every variable a launch must skip, and keeps the COFORGE_ knobs an Agent may set", () => {
    expect(
      launchUnsafeAgentEnvironmentNames({
        NODE_OPTIONS: "--require ./x.js",
        MY_VAR: "kept",
        dyld_insert_libraries: "libx.dylib",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        COFORGE_WAKE_RECYCLE: "0",
      }),
    ).toEqual(["NODE_OPTIONS", "dyld_insert_libraries", "GIT_CONFIG_KEY_0"]);
    expect(launchUnsafeAgentEnvironmentNames({ MY_VAR: "kept" })).toEqual([]);
  });

  test("names the first rule a variable name breaks", () => {
    expect(agentEnvironmentNameViolation("MY_VAR")).toBeUndefined();
    expect(agentEnvironmentNameViolation("11")).toBe("invalid-name");
    expect(agentEnvironmentNameViolation("A".repeat(129))).toBe("invalid-name");
    expect(agentEnvironmentNameViolation("path")).toBe("reserved-name");
    expect(agentEnvironmentNameViolation("COFORGE_TOKEN")).toBe("reserved-name");
  });

  test("names the rule a whole environment breaks, or nothing when it is valid", () => {
    expect(agentEnvironmentViolation({ A: "1", _B: "" })).toBeUndefined();
    expect(
      agentEnvironmentViolation(
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`A${i}`, "s"])),
      ),
    ).toBe("too-many");
    expect(agentEnvironmentViolation({ "11": "11" })).toBe("invalid-name");
    expect(agentEnvironmentViolation({ PATH: "/bin" })).toBe("reserved-name");
    expect(agentEnvironmentViolation({ HOME: "/elsewhere" })).toBe("reserved-name");
    expect(agentEnvironmentViolation({ node_options: "--require x" })).toBe("reserved-name");
    expect(agentEnvironmentViolation({ A: 1 })).toBe("invalid-value");
    expect(agentEnvironmentViolation({ A: "a\0" })).toBe("invalid-value");
    expect(agentEnvironmentViolation({ A: "s".repeat(32_769) })).toBe("invalid-value");
    const big = "s".repeat(32_768);
    expect(agentEnvironmentViolation({ A: big, B: big, C: big, D: big })).toBe("too-large");
  });

  test("names a shape rule without a reserved name, for an edge that skips those instead", () => {
    // The daemon reads a stored environment it must not reject outright: a reserved name is
    // skipped at launch and reported, a malformed map is still unusable.
    expect(
      agentEnvironmentShapeViolation({ NODE_OPTIONS: "x", HOME: "/elsewhere" }),
    ).toBeUndefined();
    expect(agentEnvironmentShapeViolation({ "11": "11" })).toBe("invalid-name");
    expect(agentEnvironmentShapeViolation({ A: 1 })).toBe("invalid-value");
    expect(agentEnvironmentShapeViolation({ A: "a\0" })).toBe("invalid-value");
    expect(agentEnvironmentShapeViolation({ A: "s".repeat(32_769) })).toBe("invalid-value");
    expect(
      agentEnvironmentShapeViolation(
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`A${i}`, "s"])),
      ),
    ).toBe("too-many");
  });
});
