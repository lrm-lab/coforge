import { afterEach, expect, test } from "bun:test";
import { createAntigravityAuthHost } from "#src/code-agent/antigravity/auth-host";

const ENV_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "COFORGE_COMPUTER_CLOUD"] as const;
let savedEnv: [string, string | undefined][] = [];

function isolateBrowserEnv() {
  savedEnv = ENV_KEYS.map((key) => {
    const value = process.env[key];
    delete process.env[key];
    return [key, value];
  });
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = [];
});

test("the auth host resolves its platform from the running process", () => {
  isolateBrowserEnv();
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    // Without the fix the host passes `undefined` through and every platform looks desktop-capable.
    expect(createAntigravityAuthHost({ command: ["agy"] }).canOpenBrowser).toBe(false);
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
});

test("an injected platform decides browser support without a display", () => {
  isolateBrowserEnv();
  expect(createAntigravityAuthHost({ command: ["agy"], platform: "linux" }).canOpenBrowser).toBe(
    false,
  );
  expect(createAntigravityAuthHost({ command: ["agy"], platform: "darwin" }).canOpenBrowser).toBe(
    true,
  );
});

test("a display variable qualifies a linux host", () => {
  isolateBrowserEnv();
  process.env.DISPLAY = ":0";
  expect(createAntigravityAuthHost({ command: ["agy"], platform: "linux" }).canOpenBrowser).toBe(
    true,
  );
});

test("the cloud computer marker never qualifies for a browser", () => {
  isolateBrowserEnv();
  process.env.COFORGE_COMPUTER_CLOUD = "1";
  expect(createAntigravityAuthHost({ command: ["agy"], platform: "darwin" }).canOpenBrowser).toBe(
    false,
  );
});
