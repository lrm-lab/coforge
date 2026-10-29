import { describe, expect, test } from "bun:test";

import {
  parseOperatorEntries,
  parseOperatorEntry,
} from "#src/server/app-marketplace/platform-operators.server";

describe("parseOperatorEntry", () => {
  test("an email is trimmed and lower-cased", () => {
    expect(parseOperatorEntry("  Ada@Example.COM ")).toEqual({
      kind: "email",
      value: "ada@example.com",
    });
  });

  test("a mainland China number becomes E.164, however it is typed", () => {
    for (const typed of ["13800138000", "138 0013 8000", "+8613800138000", "138-0013-8000"])
      expect(parseOperatorEntry(typed)).toEqual({ kind: "phone", value: "+8613800138000" });
  });

  test("anything else is no entry at all", () => {
    for (const typed of ["", "   ", "ada", "ada@", "+14155550100", "not an address"])
      expect(parseOperatorEntry(typed)).toBeNull();
  });
});

describe("parseOperatorEntries", () => {
  test("splits on commas, ignores blanks, and reports what it cannot read", () => {
    expect(parseOperatorEntries(" ada@example.com , ,13800138000, nope ,+14155550100")).toEqual({
      entries: [
        { kind: "email", value: "ada@example.com" },
        { kind: "phone", value: "+8613800138000" },
      ],
      invalid: ["nope", "+14155550100"],
    });
  });

  test("an unset value configures nobody and reports nothing", () => {
    expect(parseOperatorEntries(undefined)).toEqual({ entries: [], invalid: [] });
    expect(parseOperatorEntries("")).toEqual({ entries: [], invalid: [] });
  });
});
