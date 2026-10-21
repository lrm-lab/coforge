import { expect, test } from "bun:test";

import { cloudDesktopUrl } from "#src/features/computers/cloud-desktop-url";

const COMPUTER = "01a15829-2da5-740c-848c-c287bf1e8ab6";

test("a cloud desktop opens on the page host's proxy, without a token", () => {
  expect(cloudDesktopUrl("https://cloud.example.com/w/acme/computers", COMPUTER)).toBe(
    `http://cloud.example.com:6090/desktop/${COMPUTER}/`,
  );
  expect(cloudDesktopUrl("http://10.0.0.8:8788/w/acme", COMPUTER)).toBe(
    `http://10.0.0.8:6090/desktop/${COMPUTER}/`,
  );
});

test("a computer id that is not a single path segment is refused", () => {
  expect(cloudDesktopUrl("https://cloud.example.com", "../other")).toBeUndefined();
  expect(cloudDesktopUrl("https://cloud.example.com", "a/b")).toBeUndefined();
  expect(cloudDesktopUrl("not a url", COMPUTER)).toBeUndefined();
});
