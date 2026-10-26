import { expect, spyOn, test } from "bun:test";
import {
  runtimeAuthView,
  storedRuntimeAuth,
} from "#src/server/computers/computer-runtime-auth.server";

test("a supported runtime's report survives storage without depending on the writer's provider list", () => {
  const kiro = {
    provider: "kiro",
    state: "logged_in",
    account: { methodLabel: "IAM Identity Center" },
  } as const;
  const stored = JSON.parse(JSON.stringify(storedRuntimeAuth(123, [kiro])));
  expect(runtimeAuthView(stored, { showAccount: true, visibleProviders: ["codex"] })).toEqual({});
  expect(runtimeAuthView(stored, { showAccount: true, visibleProviders: ["kiro"] })).toEqual({
    kiro,
  });
  expect(stored.collectedAtMs).toBe(123);
});

test("an unknown provider is preserved with safe labels but never projected to a viewer", () => {
  const stored = storedRuntimeAuth(123, [
    {
      provider: "future-cli",
      state: "logged_in",
      account: { maskedLabel: "unmasked@example.com", planLabel: "Pro", token: "secret" },
      token: "secret",
    },
  ]);
  expect(stored.runtimes).toEqual({
    "future-cli": { provider: "future-cli", state: "logged_in", account: { planLabel: "Pro" } },
  });
  expect(runtimeAuthView(stored, { showAccount: true, visibleProviders: ["future-cli"] })).toEqual(
    {},
  );
  expect(JSON.stringify(stored)).not.toContain("secret");
});

test("unknown providers follow the existing state, reason and account sanitization", () => {
  const stored = storedRuntimeAuth(1, [
    { provider: "future-one", state: "logged_out", account: { planLabel: "Pro" } },
    { provider: "future-two", state: "unavailable", unavailableReason: "not_installed" },
    { provider: "future-three", state: "unavailable", unavailableReason: "new_reason" },
    {
      provider: "future-four",
      state: "logged_in",
      account: { maskedLabel: "a***@b.c", methodLabel: "bad\nlabel" },
    },
  ]);
  expect(stored.runtimes).toEqual({
    "future-one": { provider: "future-one", state: "logged_out" },
    "future-two": {
      provider: "future-two",
      state: "unavailable",
      unavailableReason: "not_installed",
    },
    "future-three": { provider: "future-three", state: "unknown" },
    "future-four": {
      provider: "future-four",
      state: "logged_in",
      account: { maskedLabel: "a***@b.c" },
    },
  });
});

test("storage refuses duplicate providers and more than 32 entries", () => {
  expect(() =>
    storedRuntimeAuth(1, [
      { provider: "codex", state: "logged_in" },
      { provider: "codex", state: "logged_out" },
    ]),
  ).toThrow();
  expect(() =>
    storedRuntimeAuth(
      1,
      Array.from({ length: 33 }, (_, i) => ({ provider: `future-${i}`, state: "unknown" })),
    ),
  ).toThrow();
  expect(
    Object.keys(
      storedRuntimeAuth(
        1,
        Array.from({ length: 32 }, (_, i) => ({ provider: `future-${i}`, state: "unknown" })),
      ).runtimes,
    ),
  ).toHaveLength(32);
});

test("the normalized JSON has a 16 KiB bound even when valid labels use multiple UTF-8 bytes", () => {
  expect(() =>
    storedRuntimeAuth(
      1,
      Array.from({ length: 32 }, (_, i) => ({
        provider: `future-${i}`,
        state: "logged_in",
        account: {
          maskedLabel: `***${"界".repeat(70)}`,
          planLabel: "界".repeat(70),
          methodLabel: "界".repeat(40),
        },
      })),
    ),
  ).toThrow();
});

test("invalid entries are skipped without losing valid states or logging raw input", () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const invalid = ["", "a".repeat(65), "__proto__", "secret provider", "bad\nname"].map(
      (provider) => ({
        provider,
        state: "unknown",
        account: { maskedLabel: "secret@example.com" },
      }),
    );
    const stored = storedRuntimeAuth(1, [
      null,
      ...invalid,
      { provider: "kiro", state: "logged_in" },
    ]);
    expect(stored.runtimes).toEqual({ kiro: { provider: "kiro", state: "logged_in" } });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warning.mock.calls[0]![0])).toEqual({
      event: "runtime_auth.report_entries_skipped",
      skippedEntries: 6,
    });
  } finally {
    warning.mockRestore();
  }
});
