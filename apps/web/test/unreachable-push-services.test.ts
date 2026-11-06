import { expect, test } from "bun:test";

import { unreachablePushService } from "#src/features/notifications/unreachable-push-services";

test("Google's and Apple's push endpoints are the unreachable ones", () => {
  expect(unreachablePushService("https://fcm.googleapis.com/fcm/send/abc")).toBe("google");
  // Chrome's newer endpoints, seen on staging.
  expect(unreachablePushService("https://jmt17.google.com/fcm/send/abc")).toBe("google");
  expect(unreachablePushService("https://web.push.apple.com/QGx1")).toBe("apple");
});

test("Mozilla, Windows and malformed endpoints are not marked", () => {
  expect(unreachablePushService("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(null);
  expect(unreachablePushService("https://wns2-sg2p.notify.windows.com/w/?token=x")).toBe(null);
  expect(unreachablePushService("https://evil.example/google.com")).toBe(null);
  expect(unreachablePushService("not a url")).toBe(null);
});
