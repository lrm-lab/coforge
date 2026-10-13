import { expect, test } from "bun:test";

import { accountLabel } from "#src/features/auth/account-label";

// "Signed in as ..." names the account by the email its sign-in reported. An account without one
// (a phone-number sign-up) is named the way everyone is (`humanLabel`), never by a phone number
// and never as an `@username`, which is a handle and not who someone is.

test("an account with an email is named by it", () => {
  expect(
    accountLabel({ email: "ada@example.com", displayName: "Ada Lovelace", username: "ada" }),
  ).toBe("ada@example.com");
});

test("an account with no email is named by the person's name", () => {
  expect(accountLabel({ email: null, displayName: "Ada Lovelace", username: "ada" })).toBe(
    "Ada Lovelace",
  );
});

test("an account with no email and no name yet is named by its username, without an @", () => {
  expect(accountLabel({ email: null, displayName: null, username: "user-0a1b2c3d" })).toBe(
    "user-0a1b2c3d",
  );
});
