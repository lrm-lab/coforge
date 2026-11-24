import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

const source = readFileSync(new URL("../public/service-worker.js", import.meta.url), "utf8");

function workerHarness(windows: readonly Record<string, unknown>[]) {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const opened: string[] = [];
  const notifications: { title: string; tag: string }[] = [];
  const self = {
    registration: {
      showNotification: async (title: string, options: { tag: string }) => {
        notifications.push({ title, tag: options.tag });
      },
    },
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
  return { handlers, opened, notifications };
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

test("a delivered push requests a visible notification even with no open pages", async () => {
  const { handlers, notifications } = workerHarness([]);
  let waited: unknown;
  handlers.get("push")!({
    data: {
      json: () => ({
        title: "A message",
        body: "Preview",
        tag: "message:late",
        url: "/notifications/open",
      }),
    },
    waitUntil(value: unknown) {
      waited = value;
    },
  });
  await waited;
  expect(notifications).toEqual([{ title: "A message", tag: "message:late" }]);
});

function createCacheHarness(options: {
  buildVersion?: string;
  initialCaches?: Record<string, Map<string, Response>>;
  fetchImpl: (request: Request) => Promise<Response>;
}) {
  const stores = new Map<string, Map<string, Response>>(
    Object.entries(options.initialCaches ?? {}),
  );
  const fakeCaches = {
    async keys() {
      return [...stores.keys()];
    },
    async delete(name: string) {
      return stores.delete(name);
    },
    async open(name: string) {
      let store = stores.get(name);
      if (!store) {
        store = new Map();
        stores.set(name, store);
      }
      return {
        async match(request: Request | string) {
          const key = typeof request === "string" ? request : request.url;
          return store.get(key);
        },
        async put(request: Request | string, response: Response) {
          const key = typeof request === "string" ? request : request.url;
          store.set(key, response);
        },
        async keys() {
          return [...store.keys()].map((url) => ({ url }));
        },
        async delete(request: { url: string } | string) {
          const key = typeof request === "string" ? request : request.url;
          return store.delete(key);
        },
      };
    },
  };
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  let claimed = false;
  const self = {
    location: {
      origin: "https://coforge.example",
      href: `https://coforge.example/service-worker.js?v=${options.buildVersion ?? "build-2"}`,
    },
    skipWaiting: async () => {},
    registration: { showNotification: async () => {} },
    clients: {
      matchAll: async () => [],
      openWindow: async () => null,
      claim: async () => {
        claimed = true;
      },
    },
    addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
      handlers.set(type, handler);
    },
  };
  new Function("self", "caches", "fetch", source)(self, fakeCaches, options.fetchImpl);
  return { handlers, stores, wasClaimed: () => claimed };
}

function basicResponse(body: string, status = 200, headers?: Record<string, string>) {
  const response = new Response(body, { status, headers });
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

test("activate drops old coforge caches and keeps the current build cache", async () => {
  const { handlers, stores, wasClaimed } = createCacheHarness({
    buildVersion: "build-2",
    initialCaches: {
      "coforge-build-1": new Map(),
      "coforge-build-2": new Map(),
      "unrelated-cache": new Map(),
    },
    fetchImpl: async () => basicResponse("ok"),
  });
  let waited: unknown;
  handlers.get("activate")!({
    waitUntil(promise: unknown) {
      waited = promise;
    },
  });
  await waited;
  expect([...stores.keys()].sort()).toEqual(["coforge-build-2", "unrelated-cache"]);
  expect(wasClaimed()).toBe(true);
});

test("serves fingerprinted assets from cache without hitting the network again", async () => {
  let networkCalls = 0;
  const cachedAsset = basicResponse("console.log('cached')", 200, {
    "content-type": "application/javascript",
  });
  const assetUrl = "https://coforge.example/assets/app-abc123.js";
  const { handlers } = createCacheHarness({
    buildVersion: "build-2",
    initialCaches: {
      "coforge-build-2": new Map([[assetUrl, cachedAsset]]),
    },
    fetchImpl: async () => {
      networkCalls++;
      return basicResponse("fresh");
    },
  });
  let responded: Promise<Response> | undefined;
  handlers.get("fetch")!({
    request: {
      method: "GET",
      url: assetUrl,
      mode: "no-cors",
      destination: "script",
      headers: new Headers(),
    },
    respondWith(p: Promise<Response>) {
      responded = p;
    },
  });
  expect(responded).toBeDefined();
  const res = await responded!;
  expect(await res.text()).toBe("console.log('cached')");
  expect(networkCalls).toBe(0);
});

test("navigations try network first and fall back to cached page when offline", async () => {
  const pageUrl = "https://coforge.example/w/acme";
  const cachedPage = basicResponse("<html>cached</html>", 200, {
    "content-type": "text/html",
  });
  const { handlers } = createCacheHarness({
    buildVersion: "build-2",
    initialCaches: {
      "coforge-build-2": new Map([[pageUrl, cachedPage]]),
    },
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  let responded: Promise<Response> | undefined;
  handlers.get("fetch")!({
    request: {
      method: "GET",
      url: pageUrl,
      mode: "navigate",
      destination: "document",
      headers: new Headers(),
    },
    respondWith(p: Promise<Response>) {
      responded = p;
    },
  });
  expect(responded).toBeDefined();
  const res = await responded!;
  expect(await res.text()).toBe("<html>cached</html>");
});

test("never intercepts API calls or video requests", () => {
  const { handlers } = createCacheHarness({
    buildVersion: "build-2",
    fetchImpl: async () => basicResponse("ok"),
  });
  const requests = [
    {
      method: "GET",
      url: "https://coforge.example/api/me",
      mode: "cors",
      destination: "",
      headers: new Headers(),
    },
    {
      method: "GET",
      url: "https://coforge.example/assets/demo.mp4",
      mode: "no-cors",
      destination: "video",
      headers: new Headers(),
    },
  ];
  for (const request of requests) {
    let called = false;
    handlers.get("fetch")!({
      request,
      respondWith() {
        called = true;
      },
    });
    expect(called).toBe(false);
  }
});

test("logout clears cached HTML pages while keeping fingerprinted assets", async () => {
  const pageUrl = "https://coforge.example/w/acme";
  const assetUrl = "https://coforge.example/assets/app-abc123.js";
  const bucket = new Map<string, Response>([
    [pageUrl, basicResponse("<html>workspace</html>")],
    [assetUrl, basicResponse("console.log('ok')")],
  ]);
  const { handlers } = createCacheHarness({
    buildVersion: "build-2",
    initialCaches: { "coforge-build-2": bucket },
    fetchImpl: async () => basicResponse("ok"),
  });
  let waited: unknown;
  handlers.get("fetch")!({
    request: {
      method: "GET",
      url: "https://coforge.example/auth/logout",
      mode: "navigate",
      destination: "document",
      headers: new Headers(),
    },
    waitUntil(promise: unknown) {
      waited = promise;
    },
  });
  await waited;
  expect([...bucket.keys()]).toEqual([assetUrl]);
});

test("does not cache redirected responses and survives cache.put quota errors", async () => {
  const pageUrl = "https://coforge.example/w/acme";
  const bucket = new Map<string, Response>();
  const redirected = basicResponse("<html>login</html>", 200);
  Object.defineProperty(redirected, "redirected", { value: true });

  const { handlers } = createCacheHarness({
    buildVersion: "build-2",
    initialCaches: { "coforge-build-2": bucket },
    fetchImpl: async () => redirected,
  });

  let responded: Promise<Response> | undefined;
  handlers.get("fetch")!({
    request: {
      method: "GET",
      url: pageUrl,
      mode: "navigate",
      destination: "document",
      headers: new Headers(),
    },
    respondWith(p: Promise<Response>) {
      responded = p;
    },
  });
  expect(responded).toBeDefined();
  await responded!;
  expect(bucket.has(pageUrl)).toBe(false);
});
