import { expect, test } from "bun:test";
import { RUNTIME_AUTH_PROVIDERS } from "@lrm/coforge-anvil";

import { RUNTIME_AUTH_PROVIDERS as SDK_RUNTIME_AUTH_PROVIDERS } from "@lrm/coforge-sdk/internal";

import { runtimeLoginChip } from "#src/features/computers/runtime-login-chip";

test("the chip signs in every Anvil auth-status provider", () => {
  expect([...SDK_RUNTIME_AUTH_PROVIDERS]).toEqual([...RUNTIME_AUTH_PROVIDERS]);
});

test("a sign-in provider keeps unknown for a viewer who cannot press Sign in", () => {
  for (const provider of ["claude-code", "codex", "kiro", "command-code"] as const) {
    expect(
      runtimeLoginChip({
        provider,
        status: { provider, state: "unknown" },
        canSignIn: false,
      }),
    ).toEqual({
      auth: { provider, state: "unknown" },
      account: "unknown",
      signable: false,
    });
    expect(
      runtimeLoginChip({
        provider,
        status: { provider, state: "unknown" },
        canSignIn: true,
      }).account,
    ).toBe("unknown");
  }
});

test("a sign-in provider still offers Sign in, including when its report is missing", () => {
  expect(
    runtimeLoginChip({
      provider: "claude-code",
      status: { provider: "claude-code", state: "logged_out" },
      canSignIn: true,
    }),
  ).toEqual({
    auth: { provider: "claude-code", state: "logged_out" },
    account: "logged_out",
    signable: true,
  });
  expect(runtimeLoginChip({ provider: "kiro", status: undefined, canSignIn: true }).account).toBe(
    "unreported",
  );
  expect(
    runtimeLoginChip({ provider: "codex", status: undefined, canSignIn: false }).signable,
  ).toBe(false);
});
