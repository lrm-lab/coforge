import { expect, test } from "bun:test";
import { MAX_LABEL, MAX_METHOD_LABEL } from "@lrm/coforge-sdk/internal";
import { sanitizeRuntimeAuthStatus } from "#src/runtime-auth-status";

test("a logged-in status keeps a masked account, its plan and its method", () => {
  expect(
    sanitizeRuntimeAuthStatus({
      provider: "claude-code",
      state: "logged_in",
      account: { maskedLabel: "fra***@example.com", planLabel: "max", methodLabel: "claude.ai" },
    }),
  ).toEqual({
    provider: "claude-code",
    state: "logged_in",
    account: { maskedLabel: "fra***@example.com", planLabel: "max", methodLabel: "claude.ai" },
  });
});

test("an account label that is not visibly masked, or too long, is dropped with its empty account", () => {
  const status = (maskedLabel: string) =>
    sanitizeRuntimeAuthStatus({ provider: "codex", state: "logged_in", account: { maskedLabel } });
  expect(status("frank@example.com")).toEqual({ provider: "codex", state: "logged_in" });
  expect(status(`a*${"b".repeat(MAX_LABEL)}`)).toEqual({
    provider: "codex",
    state: "logged_in",
  });
  expect(status("fr•••@example.com")?.account?.maskedLabel).toBe("fr•••@example.com");
  expect(status("fra…@example.com")?.account?.maskedLabel).toBe("fra…@example.com");
});

test("a plan or method past its limit, empty, or holding control characters is dropped", () => {
  expect(
    sanitizeRuntimeAuthStatus({
      provider: "codex",
      state: "logged_in",
      account: {
        planLabel: "p".repeat(MAX_LABEL + 1),
        methodLabel: "m".repeat(MAX_METHOD_LABEL + 1),
      },
    }),
  ).toEqual({ provider: "codex", state: "logged_in" });
  expect(
    sanitizeRuntimeAuthStatus({
      provider: "codex",
      state: "logged_in",
      account: { planLabel: "pro\u0007", methodLabel: " " },
    }),
  ).toEqual({ provider: "codex", state: "logged_in" });
});

test("only a logged-in status carries an account, and only an unavailable one a reason", () => {
  expect(
    sanitizeRuntimeAuthStatus({
      provider: "codex",
      state: "logged_out",
      account: { maskedLabel: "a***@b.c", planLabel: "pro" },
      unavailableReason: "not_installed",
    }),
  ).toEqual({ provider: "codex", state: "logged_out" });
  expect(
    sanitizeRuntimeAuthStatus({
      provider: "claude-code",
      state: "unavailable",
      unavailableReason: "version_unsupported",
      account: { planLabel: "pro" },
    }),
  ).toEqual({
    provider: "claude-code",
    state: "unavailable",
    unavailableReason: "version_unsupported",
  });
});

test("anything that does not fit the schema reads as unknown for its provider", () => {
  expect(sanitizeRuntimeAuthStatus({ provider: "codex", state: "signed_in" })).toEqual({
    provider: "codex",
    state: "unknown",
  });
  expect(
    sanitizeRuntimeAuthStatus({ provider: "codex", state: "unavailable", unavailableReason: "x" }),
  ).toEqual({ provider: "codex", state: "unknown" });
  expect(sanitizeRuntimeAuthStatus({ provider: "codex", state: "unavailable" })).toEqual({
    provider: "codex",
    state: "unknown",
  });
  expect(sanitizeRuntimeAuthStatus(null, "codex")).toEqual({ provider: "codex", state: "unknown" });
  expect(sanitizeRuntimeAuthStatus("logged_in", "claude-code")).toEqual({
    provider: "claude-code",
    state: "unknown",
  });
});

test("a status for a provider without a login flow is nothing", () => {
  expect(sanitizeRuntimeAuthStatus({ provider: "pi", state: "logged_in" })).toBeUndefined();
  expect(sanitizeRuntimeAuthStatus({ state: "logged_in" })).toBeUndefined();
});
