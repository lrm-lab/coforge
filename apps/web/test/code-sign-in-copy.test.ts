import { expect, test } from "bun:test";

import { validateCodeSignInDestination } from "#src/features/auth/code-destination";

test("phone code tab accepts mainland phone or email and reports invalid_destination otherwise", () => {
  expect(validateCodeSignInDestination("phone", "13800138000")).toBeNull();
  expect(validateCodeSignInDestination("phone", "+86 138-0013-8000")).toBeNull();
  expect(validateCodeSignInDestination("phone", "alice@coforge.test")).toBeNull();
  expect(validateCodeSignInDestination("phone", "123")).toBe("invalid_destination");
  expect(validateCodeSignInDestination("phone", "")).toBe("invalid_destination");
});

test("email code form only accepts email addresses and reports invalid_email_destination otherwise", () => {
  expect(validateCodeSignInDestination("email", "alice@coforge.test")).toBeNull();
  expect(validateCodeSignInDestination("email", "13800138000")).toBe("invalid_email_destination");
  expect(validateCodeSignInDestination("email", "123")).toBe("invalid_email_destination");
});
