import { expect, test } from "bun:test";
import {
  RUNTIME_AUTH_CODE_MAX_LENGTH,
  RUNTIME_AUTH_PROVIDERS,
  isRuntimeAuthProvider,
  normalizeRuntimeAuthCode,
} from "#src/code-agent/contract";

test("runtime auth is limited to the providers with a supported login flow", () => {
  expect(RUNTIME_AUTH_PROVIDERS).toEqual(["claude-code", "codex"]);
  expect(isRuntimeAuthProvider("claude-code")).toBe(true);
  expect(isRuntimeAuthProvider("codex")).toBe(true);
  expect(isRuntimeAuthProvider("pi")).toBe(false);
  expect(isRuntimeAuthProvider("unknown")).toBe(false);
});

test("runtime auth codes discard pasted whitespace and keep the bounded value", () => {
  expect(normalizeRuntimeAuthCode("  ABC\n 123 ")).toBe("ABC123");
  expect(normalizeRuntimeAuthCode("a".repeat(RUNTIME_AUTH_CODE_MAX_LENGTH))).toHaveLength(
    RUNTIME_AUTH_CODE_MAX_LENGTH,
  );
});

test("runtime auth codes reject empty, oversized, and non-whitespace control input", () => {
  expect(() => normalizeRuntimeAuthCode(" \n\t")).toThrow("empty");
  expect(() => normalizeRuntimeAuthCode("a".repeat(RUNTIME_AUTH_CODE_MAX_LENGTH + 1))).toThrow(
    "too long",
  );
  expect(() => normalizeRuntimeAuthCode("abc\u0000def")).toThrow("control");
});
