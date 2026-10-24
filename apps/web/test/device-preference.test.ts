import { afterEach, expect, test } from "bun:test";

import { createDevicePreference } from "#src/features/settings/device-preference";

const originalWindow = globalThis.window;
afterEach(() => {
  globalThis.window = originalWindow;
});

/** A window that counts its `storage` listeners. */
function countingWindow() {
  const target = new EventTarget();
  let storageListeners = 0;
  const window = Object.assign(target, {
    addEventListener: (type: string, listener: EventListener) => {
      if (type === "storage") storageListeners += 1;
      EventTarget.prototype.addEventListener.call(target, type, listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      if (type === "storage") storageListeners -= 1;
      EventTarget.prototype.removeEventListener.call(target, type, listener);
    },
  });
  globalThis.window = window as unknown as typeof globalThis.window;
  return { window, storageListeners: () => storageListeners };
}

test("every subscriber of a preference shares one storage listener, there while anyone is", () => {
  const { window, storageListeners } = countingWindow();
  const applied: boolean[] = [];
  const preference = createDevicePreference<boolean>({
    key: "coforge-test-flag",
    parse: (stored) => stored !== "hide",
    serialize: (show) => (show ? "show" : "hide"),
    fallback: true,
    apply: (value) => applied.push(value),
  });
  const heard: string[] = [];
  const stops = ["a", "b", "c"].map((name) => preference.subscribe(() => heard.push(name)));
  expect(storageListeners()).toBe(1);

  const event = Object.assign(new Event("storage"), { key: "coforge-test-flag", newValue: "hide" });
  window.dispatchEvent(event);
  window.dispatchEvent(Object.assign(new Event("storage"), { key: "another-key", newValue: "x" }));
  expect(heard).toEqual(["a", "b", "c"]);
  expect(applied).toEqual([false]);

  for (const stop of stops) stop();
  expect(storageListeners()).toBe(0);
});
