import { expect, test } from "bun:test";

import { browserDeviceKind, browserDeviceLabel } from "#src/features/notifications/browser-push";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const WINDOWS_EDGE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0";

// Task #467/#469: a phone's subscription says so, for its notifications to wait while the person
// is at a computer; Settings names each device.
test("a phone or tablet subscribes as mobile, a computer as desktop", () => {
  expect(browserDeviceKind(MAC_CHROME, 0)).toBe("desktop");
  expect(browserDeviceKind(WINDOWS_EDGE, 0)).toBe("desktop");
  expect(browserDeviceKind(IPHONE_SAFARI, 5)).toBe("mobile");
  expect(browserDeviceKind(ANDROID_CHROME, 5)).toBe("mobile");
  // An iPad asks for the desktop site and reads as a Mac, except that it has touch points.
  expect(browserDeviceKind(IPAD_AS_MAC, 5)).toBe("mobile");
  expect(browserDeviceKind(IPAD_AS_MAC, 0)).toBe("desktop");
});

test("a device is named by its browser and system", () => {
  expect(browserDeviceLabel(MAC_CHROME)).toBe("macOS · Chrome");
  expect(browserDeviceLabel(IPHONE_SAFARI)).toBe("iPhone · Safari");
  expect(browserDeviceLabel(ANDROID_CHROME)).toBe("Android · Chrome");
  expect(browserDeviceLabel(WINDOWS_EDGE)).toBe("Windows · Edge");
  expect(browserDeviceLabel("curl/8")).toBe("Browser");
});
