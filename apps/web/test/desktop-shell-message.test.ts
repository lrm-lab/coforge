import { expect, test } from "bun:test";

import { desktopShellActionFromMessage } from "#src/features/computers/desktop-shell-message";

test("reads minimize, sleep and landscape actions from the desktop iframe", () => {
  expect(desktopShellActionFromMessage({ coforgeDesktop: true, action: "minimize" })).toBe(
    "minimize",
  );
  expect(desktopShellActionFromMessage({ coforgeDesktop: true, action: "sleep" })).toBe("sleep");
  expect(desktopShellActionFromMessage({ coforgeDesktop: true, action: "toggle-landscape" })).toBe(
    "toggle-landscape",
  );
});

test("ignores other postMessage bodies", () => {
  expect(desktopShellActionFromMessage(undefined)).toBeUndefined();
  expect(desktopShellActionFromMessage({ coforgeDesktop: true, action: "paste" })).toBeUndefined();
  expect(desktopShellActionFromMessage({ action: "minimize" })).toBeUndefined();
});
