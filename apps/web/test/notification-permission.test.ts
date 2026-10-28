import { expect, test } from "bun:test";

import { notificationsAskable } from "#src/features/notifications/notification-permission";

test("the banner may ask only when both readings say the site has not been asked", () => {
  expect(notificationsAskable("default", "prompt")).toBe(true);
  // Chrome's synchronous value can read "default" for a site its permission record allows.
  expect(notificationsAskable("default", "granted")).toBe(false);
  expect(notificationsAskable("default", "denied")).toBe(false);
  expect(notificationsAskable("granted", "prompt")).toBe(false);
});

test("without a Permissions API answer the synchronous value decides", () => {
  expect(notificationsAskable("default", undefined)).toBe(true);
  expect(notificationsAskable("granted", undefined)).toBe(false);
  expect(notificationsAskable("unsupported", undefined)).toBe(false);
});
