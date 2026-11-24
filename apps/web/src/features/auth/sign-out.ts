import { forgetQueryCache } from "#src/features/cache-persistence/browser-query-cache";

const FORGET_TIMEOUT_MS = 2_000;
const SW_CACHE_PREFIX = "coforge-";

async function clearOfflinePageCache(): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.serviceWorker?.controller) {
    navigator.serviceWorker.controller.postMessage({ type: "clear-pages" });
  }
  if (typeof caches === "undefined") return;
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(SW_CACHE_PREFIX))
      .map(async (key) => {
        const cache = await caches.open(key);
        const requests = await cache.keys();
        await Promise.all(
          requests
            .filter((request) => {
              try {
                return !new URL(request.url).pathname.startsWith("/assets/");
              } catch {
                return true;
              }
            })
            .map((request) => cache.delete(request)),
        );
      }),
  );
}

export async function signOut(href = "/auth/logout") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([
        forgetQueryCache().catch(() => undefined),
        clearOfflinePageCache().catch(() => undefined),
      ]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FORGET_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  window.location.assign(href);
}
