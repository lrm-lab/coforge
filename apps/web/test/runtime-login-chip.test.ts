import { expect, test } from "bun:test";
import { RUNTIME_AUTH_PROVIDERS } from "@lrm/coforge-anvil";

import {
  RUNTIME_LOGIN_STATE_PROVIDERS,
  runtimeLoginChip,
} from "#src/features/computers/runtime-login-chip";

test("the chip shows every Anvil auth-status provider, and signs in only the SDK set", () => {
  expect([...RUNTIME_LOGIN_STATE_PROVIDERS]).toEqual([...RUNTIME_AUTH_PROVIDERS]);
});

test("Command Code shows logged in and logged out with no Sign in", () => {
  expect(
    runtimeLoginChip({
      provider: "command-code",
      status: { provider: "command-code", state: "logged_in" },
      canSignIn: true,
    }),
  ).toEqual({
    auth: { provider: "command-code", state: "logged_in" },
    account: "logged_in",
    signable: false,
  });
  expect(
    runtimeLoginChip({
      provider: "command-code",
      status: { provider: "command-code", state: "logged_out" },
      canSignIn: true,
    }),
  ).toEqual({
    auth: { provider: "command-code", state: "logged_out" },
    account: "logged_out",
    signable: false,
  });
});

test("an untrustworthy Command Code probe is not shown as logged out", () => {
  expect(
    runtimeLoginChip({
      provider: "command-code",
      status: { provider: "command-code", state: "unknown" },
      canSignIn: true,
    }),
  ).toEqual({
    auth: { provider: "command-code", state: "unknown" },
    account: undefined,
    signable: false,
  });
  expect(
    runtimeLoginChip({ provider: "command-code", status: undefined, canSignIn: true }),
  ).toEqual({ auth: undefined, account: undefined, signable: false });
});

test("a sign-in provider keeps unknown for a viewer who cannot press Sign in", () => {
  for (const provider of ["claude-code", "codex", "kiro"] as const) {
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
