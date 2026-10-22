import { expect, test } from "bun:test";

import {
  CLOUD_DESKTOP_WINDOW_FEATURES,
  cloudDesktopUrl,
  cloudDesktopWindowName,
} from "#src/features/computers/cloud-desktop-url";

const COMPUTER = "01a15829-2da5-740c-848c-c287bf1e8ab6";

test("a cloud desktop opens on the configured proxy, without a token", () => {
  expect(cloudDesktopUrl("http://10.110.158.143:6090", COMPUTER)).toBe(
    `http://10.110.158.143:6090/desktop/${COMPUTER}/`,
  );
  expect(cloudDesktopUrl("https://desktop.example.com/", COMPUTER)).toBe(
    `https://desktop.example.com/desktop/${COMPUTER}/`,
  );
});

test("an agent's desktop is that computer's screen for that agent", () => {
  const agent = "01a15829-2da5-740c-848c-c287bf1e8ab7";
  expect(cloudDesktopUrl("http://10.110.158.143:6090", COMPUTER, agent)).toBe(
    `http://10.110.158.143:6090/desktop/${COMPUTER}/${agent}/`,
  );
  expect(cloudDesktopUrl("http://10.110.158.143:6090", COMPUTER, "a/b")).toBeUndefined();
});

test("an agent's desktop carries that agent's name as its window title", () => {
  const agent = "01a15829-2da5-740c-848c-c287bf1e8ab7";
  const url = cloudDesktopUrl("http://10.110.158.143:6090", COMPUTER, agent, "  小明  ");
  expect(url).toBeDefined();
  const desktop = new URL(url!);
  expect(desktop.pathname).toBe(`/desktop/${COMPUTER}/${agent}/`);
  expect(desktop.searchParams.get("title")).toBe("小明");
  expect(desktop.searchParams.get("token")).toBeNull();
  expect(
    new URL(
      cloudDesktopUrl("http://10.110.158.143:6090", COMPUTER, agent, "A&B<C>")!,
    ).searchParams.get("title"),
  ).toBe("A&B<C>");
  expect(cloudDesktopUrl("http://10.110.158.143:6090", COMPUTER, agent, "   ")).toBe(
    `http://10.110.158.143:6090/desktop/${COMPUTER}/${agent}/`,
  );
});

test("a desktop opens in its own sized window", () => {
  const agent = "01a15829-2da5-740c-848c-c287bf1e8ab7";
  expect(CLOUD_DESKTOP_WINDOW_FEATURES.startsWith("popup,")).toBe(true);
  expect(CLOUD_DESKTOP_WINDOW_FEATURES).toContain("width=1280");
  expect(CLOUD_DESKTOP_WINDOW_FEATURES).toContain("height=800");
  expect(cloudDesktopWindowName(COMPUTER)).toBe(`coforge-desktop-${COMPUTER}`);
  expect(cloudDesktopWindowName(COMPUTER, agent)).toBe(`coforge-desktop-${COMPUTER}-${agent}`);
});

test("a computer id or origin that is not one desktop proxy is refused", () => {
  expect(cloudDesktopUrl("http://10.110.158.143:6090", "../other")).toBeUndefined();
  expect(cloudDesktopUrl("http://10.110.158.143:6090", "a/b")).toBeUndefined();
  expect(cloudDesktopUrl("https://staging.example.com/w/acme", COMPUTER)).toBeUndefined();
  expect(cloudDesktopUrl("not a url", COMPUTER)).toBeUndefined();
});
