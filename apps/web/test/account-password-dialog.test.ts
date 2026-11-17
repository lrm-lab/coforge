import { describe, expect, test } from "bun:test";
import {
  accountPasswordProblemText,
  bindArrivalFrom,
  canSavePassword,
  defaultContact,
  githubBindPath,
  passwordContacts,
  passwordStart,
  type AccountPasswordProblem,
} from "#src/features/profiles/account-password-logic";

const PROBLEMS: AccountPasswordProblem[] = [
  "invalid_input",
  "failed",
  "no_contact",
  "identity_mismatch",
  "rate_limited",
  "invalid_code",
  "password_refused",
  "send_failed",
  "invalid_destination",
  "invalid_bind_token",
  "unavailable",
  "refused",
  "bind_failed",
  "github_denied",
  "github_failed",
];

const none = { email: null, emailVerified: null, phone: null, phoneVerified: null };

describe("accountPasswordProblemText", () => {
  test.each(PROBLEMS)("%s reads as a sentence, not a code", (problem) => {
    const text = accountPasswordProblemText(problem);
    expect(text.length).toBeGreaterThan(8);
    expect(text).not.toContain(problem);
    expect(text).not.toContain("_");
  });
});

describe("passwordContacts and passwordStart", () => {
  test("only verified contacts are offered, and a phone only when it is a mainland mobile", () => {
    expect(passwordContacts({ ...none, email: "a@b.co", emailVerified: false })).toEqual({});
    expect(passwordContacts({ ...none, email: "a@b.co", emailVerified: null })).toEqual({});
    expect(passwordContacts({ ...none, email: "a@b.co", emailVerified: true })).toEqual({
      email: "a@b.co",
    });
    expect(passwordContacts({ ...none, phone: "+14155550123", phoneVerified: true })).toEqual({});
    expect(passwordContacts({ ...none, phone: "+8613800138000", phoneVerified: false })).toEqual(
      {},
    );
    expect(passwordContacts({ ...none, phone: "+8613800138000", phoneVerified: true })).toEqual({
      phone: "+8613800138000",
    });
  });

  test("a contact just bound is offered beside the profile's", () => {
    const profile = { ...none, email: "a@b.co", emailVerified: true };
    expect(passwordContacts(profile, { phone: "+8613800138000" })).toEqual({
      email: "a@b.co",
      phone: "+8613800138000",
    });
  });

  test("the dialog opens at the password form when a code can go somewhere", () => {
    expect(passwordStart({ email: "a@b.co" })).toEqual({ step: "password", problem: null });
    expect(passwordStart({ phone: "+8613800138000" }).step).toBe("password");
  });

  test("with no contact it asks for one first", () => {
    expect(passwordStart({})).toEqual({ step: "need_contact", problem: null });
  });

  test("the way back from GitHub opens the bind form, or says why not", () => {
    expect(passwordStart({}, { ok: true })).toEqual({ step: "bind", problem: null });
    expect(passwordStart({ email: "a@b.co" }, { ok: true }).step).toBe("bind");
    expect(passwordStart({ email: "a@b.co" }, { ok: false, problem: "github_denied" })).toEqual({
      step: "need_contact",
      problem: "github_denied",
    });
  });

  test("the email is the first offered, else the phone", () => {
    expect(defaultContact({ email: "a@b.co", phone: "+8613800138000" })).toBe("email");
    expect(defaultContact({ phone: "+8613800138000" })).toBe("phone");
  });
});

describe("bindArrivalFrom", () => {
  test("reads the search the callback leaves", () => {
    expect(bindArrivalFrom({})).toBeUndefined();
    expect(bindArrivalFrom({ bind: 1 })).toEqual({ ok: true });
    expect(bindArrivalFrom({ bind: "1" })).toEqual({ ok: true });
    expect(bindArrivalFrom({ bindError: "github_denied" })).toEqual({
      ok: false,
      problem: "github_denied",
    });
    for (const error of ["github_failed", "identity_mismatch", "unavailable"]) {
      expect(bindArrivalFrom({ bindError: error })).toEqual({
        ok: false,
        problem: "github_failed",
      });
    }
  });
});

describe("githubBindPath", () => {
  test("returns to the current page's Account section, as a same-site path", () => {
    const path = githubBindPath("/w/acme/settings");
    expect(path.startsWith("/auth/github?mode=bind&returnTo=")).toBe(true);
    const returnTo = new URL(path, "https://example.test").searchParams.get("returnTo");
    expect(returnTo).toBe("/w/acme/settings?section=account");
  });

  test("a path without its leading slash still starts with one", () => {
    const returnTo = new URL(
      githubBindPath("w/x/settings"),
      "https://example.test",
    ).searchParams.get("returnTo");
    expect(returnTo?.startsWith("/")).toBe(true);
  });
});

describe("canSavePassword", () => {
  test("needs a 4 to 8 digit code and a password of 8 to 128 characters", () => {
    expect(canSavePassword("123456", "longenough")).toBe(true);
    expect(canSavePassword(" 1234 ", "12345678")).toBe(true);
    expect(canSavePassword("123", "longenough")).toBe(false);
    expect(canSavePassword("123456789", "longenough")).toBe(false);
    expect(canSavePassword("12a456", "longenough")).toBe(false);
    expect(canSavePassword("123456", "short")).toBe(false);
    expect(canSavePassword("123456", "x".repeat(129))).toBe(false);
    expect(canSavePassword("123456", "x".repeat(128))).toBe(true);
  });
});
