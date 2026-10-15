import { describe, expect, test } from "bun:test";

import { initialDisplayName, UNNAMED_PERSON_NAME } from "#src/features/auth/name-prefill";

describe("the name an account starts with", () => {
  test("is the provider's name when it reads as one", () => {
    expect(initialDisplayName({ name: " Grace  Hopper ", nickname: "gh", email: "g@x.io" })).toBe(
      "Grace Hopper",
    );
  });

  test("falls back to the nickname, then to the email's local part", () => {
    expect(initialDisplayName({ name: "", nickname: "Gracie", email: "grace@x.io" })).toBe(
      "Gracie",
    );
    expect(initialDisplayName({ name: "+86 138 0013 8000", email: "grace.h@x.io" })).toBe(
      "grace.h",
    );
  });

  test("is a placeholder, never a username, when the provider told us nothing", () => {
    expect(initialDisplayName({})).toBe(UNNAMED_PERSON_NAME);
    expect(initialDisplayName({ name: "System", email: null })).toBe(UNNAMED_PERSON_NAME);
  });
});
