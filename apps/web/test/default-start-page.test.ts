import { expect, test } from "bun:test";

import { isDefaultStartPage } from "#src/features/auth/return-to";

test("only no returnTo, or the start page itself, is the default start page", () => {
  expect(isDefaultStartPage(undefined)).toBe(true);
  expect(isDefaultStartPage("/")).toBe(true);
  for (const root of ["/en", "/en/", "/zh-CN", "/zh-CN/"])
    expect(isDefaultStartPage(root)).toBe(true);
  expect(isDefaultStartPage("/en/join/abc")).toBe(false);
  expect(isDefaultStartPage("/join/abc")).toBe(false);
  expect(isDefaultStartPage("/w/acme")).toBe(false);
});
