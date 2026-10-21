import { expect, test } from "bun:test";

import {
  followInternalLinkClick,
  internalAppHref,
} from "#src/features/conversations/internal-app-href";

const REPORT = "/w/acme/records/01a15829-2da5-740c-848c-c287bf1e8ab6";

test("a Workspace page path is opened in the app, with its query and hash kept", () => {
  expect(internalAppHref(REPORT)).toBe(REPORT);
  expect(internalAppHref(`${REPORT}?tab=weekly`)).toBe(`${REPORT}?tab=weekly`);
  expect(internalAppHref(`${REPORT}#section`)).toBe(`${REPORT}#section`);
  expect(internalAppHref(`  ${REPORT}  `)).toBe(REPORT);
});

test("a path that URL resolution moves is the resolved Workspace path", () => {
  expect(internalAppHref("/w/acme/../admin")).toBe("/w/admin");
  expect(internalAppHref("/w/acme/%2e%2e/secret")).toBe("/w/secret");
});

test("an external, relative, or non-workspace href is not an in-app link", () => {
  expect(internalAppHref("https://evil.example/w/acme/records/id")).toBeUndefined();
  expect(internalAppHref("//evil.example/w/acme")).toBeUndefined();
  expect(internalAppHref("javascript:alert(1)")).toBeUndefined();
  expect(internalAppHref("/login")).toBeUndefined();
  expect(internalAppHref("/en/w/acme/records/id")).toBeUndefined();
  expect(internalAppHref("w/acme/records/id")).toBeUndefined();
  expect(internalAppHref("/w/Admin/records/x")).toBeUndefined();
  expect(internalAppHref("/w/acme/../../evil")).toBeUndefined();
  expect(internalAppHref("/w/acme/records/id\n")).toBeUndefined();
  expect(internalAppHref("/w/acme\\evil")).toBeUndefined();
  expect(internalAppHref(undefined)).toBeUndefined();
});

const plainClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};

test("a plain click on an in-app link stays in this window", () => {
  expect(followInternalLinkClick(plainClick)).toBe(true);
});

test("a modified click on an in-app link is left to the browser", () => {
  expect(followInternalLinkClick({ ...plainClick, metaKey: true })).toBe(false);
  expect(followInternalLinkClick({ ...plainClick, ctrlKey: true })).toBe(false);
  expect(followInternalLinkClick({ ...plainClick, shiftKey: true })).toBe(false);
  expect(followInternalLinkClick({ ...plainClick, altKey: true })).toBe(false);
  expect(followInternalLinkClick({ ...plainClick, button: 1 })).toBe(false);
  expect(followInternalLinkClick({ ...plainClick, defaultPrevented: true })).toBe(false);
});
