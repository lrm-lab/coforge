import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const source = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

function workerHarness(windows: readonly Record<string, unknown>[]) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const opened: string[] = [];
  const self = {
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      handlers.set(type, handler);
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        opened.push(url);
        return { url };
      },
    },
  };
  new Function("self", source)(self);
  return { handlers, opened };
}

async function clickNotification(
  windows: readonly Record<string, unknown>[],
  url: string,
): Promise<{ opened: string[]; waited: unknown }> {
  const harness = workerHarness(windows);
  let waited: unknown;
  harness.handlers.get("notificationclick")!({
    notification: { data: { url }, close() {} },
    waitUntil(value: unknown) {
      waited = value;
    },
  });
  await waited;
  return { opened: harness.opened, waited };
}

test("a notification click navigates the visible CoForge window", async () => {
  const calls: string[] = [];
  const hidden = {
    visibilityState: "hidden",
    async navigate() {
      calls.push("hidden:navigate");
      return hidden;
    },
    async focus() {
      calls.push("hidden:focus");
    },
  };
  const visible = {
    visibilityState: "visible",
    async navigate(url: string) {
      calls.push(`visible:navigate:${url}`);
      return visible;
    },
    async focus() {
      calls.push("visible:focus");
    },
  };

  const result = await clickNotification([hidden, visible], "/notifications/open?target=channel");

  expect(calls).toEqual(["visible:navigate:/notifications/open?target=channel", "visible:focus"]);
  expect(result.opened).toEqual([]);
});

test("a notification click opens a new window when navigation loses its client", async () => {
  const stale = {
    visibilityState: "visible",
    async navigate() {
      return null;
    },
    async focus() {},
  };

  const result = await clickNotification([stale], "/notifications/open?target=dm");

  expect(result.opened).toEqual(["/notifications/open?target=dm"]);
});

test("a notification click prefers the focused window before a visible one", async () => {
  const calls: string[] = [];
  const visible = {
    visibilityState: "visible",
    focused: false,
    async navigate() {
      calls.push("visible:navigate");
      return visible;
    },
    async focus() {
      calls.push("visible:focus");
    },
  };
  const focused = {
    visibilityState: "hidden",
    focused: true,
    async navigate() {
      calls.push("focused:navigate");
      return focused;
    },
    async focus() {
      calls.push("focused:focus");
    },
  };

  const result = await clickNotification([visible, focused], "/notifications/open?target=focused");

  expect(calls).toEqual(["focused:navigate", "focused:focus"]);
  expect(result.opened).toEqual([]);
});

test("a notification click opens a new window when navigation throws", async () => {
  const uncontrolled = {
    visibilityState: "visible",
    async navigate() {
      throw new TypeError("client is not controlled");
    },
    async focus() {},
  };

  const result = await clickNotification([uncontrolled], "/notifications/open?target=uncontrolled");

  expect(result.opened).toEqual(["/notifications/open?target=uncontrolled"]);
});
