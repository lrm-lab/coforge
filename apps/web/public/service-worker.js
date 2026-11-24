const CACHE_PREFIX = "coforge-";
const NAVIGATION_TIMEOUT_MS = 4000;
const SKIP_PATH_PREFIXES = [
  "/api/",
  "/connection",
  "/auth/",
  "/oauth/",
  "/oidc/",
  "/notifications/",
  "/_serverFn",
];

function cacheVersion() {
  try {
    const href = self.location?.href;
    if (!href) return "v1";
    const value = new URL(href).searchParams.get("v");
    return value && value.length > 0 ? value : "v1";
  } catch {
    return "v1";
  }
}

const BUILD_VERSION = cacheVersion();
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`;
const CACHING_ENABLED = BUILD_VERSION !== "development";

self.addEventListener("install", () => {
  if (typeof self.skipWaiting === "function") {
    void self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(cleanupOldCaches());
});

self.addEventListener("fetch", (event) => {
  if (!CACHING_ENABLED || typeof caches === "undefined") return;
  const request = event.request;
  if (!request || request.method !== "GET") return;
  if (request.headers?.has("range")) return;
  if (request.destination === "video" || request.destination === "audio") return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (self.location?.origin && url.origin !== self.location.origin) return;
  if (url.pathname === "/auth/logout" || url.pathname.startsWith("/auth/logout/")) {
    event.waitUntil(clearCachedPages());
    return;
  }
  if (isNeverCachedPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstWithTimeout(request));
    return;
  }

  if (isFingerprintedAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "clear-pages" && typeof event.waitUntil === "function") {
    event.waitUntil(clearCachedPages());
  } else if (event.data?.type === "clear-pages") {
    void clearCachedPages();
  }
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPushNotification(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.url));
});

function isNeverCachedPath(pathname) {
  return SKIP_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

function isFingerprintedAsset(pathname) {
  return pathname.startsWith("/assets/");
}

function isCacheableResponse(response) {
  if (!response || response.status !== 200 || response.type !== "basic" || response.redirected) {
    return false;
  }
  const cacheControl = (response.headers?.get("cache-control") ?? "").toLowerCase();
  return !cacheControl.includes("no-store");
}

async function safeCachePut(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch {
    return;
  }
}

async function cleanupOldCaches() {
  if (typeof caches !== "undefined") {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    );
  }
  if (typeof self.clients?.claim === "function") {
    await self.clients.claim();
  }
}

async function clearCachedPages() {
  if (typeof caches === "undefined") return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX))
      .map(async (key) => {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        await Promise.all(
          requests
            .filter((req) => {
              try {
                return !isFingerprintedAsset(new URL(req.url).pathname);
              } catch {
                return true;
              }
            })
            .map((req) => cache.delete(req)),
        );
      }),
  );
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    await safeCachePut(cache, request, response);
  }
  return response;
}

async function networkFirstWithTimeout(request) {
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request).then(async (response) => {
    if (isCacheableResponse(response)) {
      await safeCachePut(cache, request, response);
    }
    return response;
  });

  let timer;
  const fallback = new Promise((resolve) => {
    timer = setTimeout(async () => {
      const cached = await cache.match(request).catch(() => undefined);
      if (cached) resolve(cached);
    }, NAVIGATION_TIMEOUT_MS);
  });

  const networkOrFallback = network.catch(async (error) => {
    const cached = await cache.match(request).catch(() => undefined);
    if (cached) return cached;
    throw error;
  });

  try {
    const result = await Promise.race([networkOrFallback, fallback]);
    void network.catch(() => {});
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function showPushNotification(event) {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (!validPayload(payload)) return;
  await self.registration.showNotification(payload.title, {
    body: payload.body,
    icon: "/icon-192.png",
    tag: payload.tag,
    data: { url: payload.url },
    silent: payload.silent === true,
  });
}

async function openNotificationTarget(url) {
  if (typeof url !== "string" || !url.startsWith("/")) return;
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing =
    windows.find((client) => client.focused === true) ??
    windows.find((client) => client.visibilityState === "visible") ??
    windows[0];
  if (existing) {
    try {
      const navigated = await existing.navigate(url);
      if (navigated) return navigated.focus();
    } catch {
      return self.clients.openWindow(url);
    }
  }
  return self.clients.openWindow(url);
}

function validPayload(payload) {
  return (
    payload &&
    typeof payload.title === "string" &&
    typeof payload.body === "string" &&
    typeof payload.tag === "string" &&
    typeof payload.url === "string" &&
    payload.url.startsWith("/")
  );
}
