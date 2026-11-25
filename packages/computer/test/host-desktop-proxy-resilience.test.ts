import { describe, expect, test } from "bun:test";

import {
  DESKTOP_WS_MAX_QUEUED_FRAMES,
  startDesktopProxy,
  type DesktopEndpoint,
} from "#src/host/desktop-proxy";
import { delay } from "#src/host/run-host";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("host delay abort listener cleanup", () => {
  test("removes the abort listener after normal timeout completion and resolves early on abort", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let activeListeners = 0;
    const origAdd = signal.addEventListener.bind(signal);
    const origRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
      activeListeners += 1;
      return origAdd(...args);
    }) as AbortSignal["addEventListener"];
    signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      activeListeners -= 1;
      return origRemove(...args);
    }) as AbortSignal["removeEventListener"];

    for (let i = 0; i < 10; i++) {
      await delay(1, signal);
    }
    expect(activeListeners).toBe(0);

    const pending = delay(60_000, signal);
    controller.abort();
    await pending;
  });
});

describe("desktop proxy endpoint caching and coalescing", () => {
  test("coalesces concurrent in-flight lookups even when TTL cache is disabled", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("asset-ok", { status: 200 }),
    });
    const upstreamPort = upstream.port!;

    let resolveCalls = 0;
    let arrived = 0;
    const allArrived = deferred<void>();
    const firstLookup = deferred<DesktopEndpoint | undefined>();

    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      endpointCacheTtlMs: 0,
      handleRequest: async () => {
        arrived += 1;
        if (arrived === 10) allArrived.resolve();
        return undefined;
      },
      resolve: async () => {
        resolveCalls += 1;
        return firstLookup.promise;
      },
    });

    try {
      const burst = Array.from({ length: 10 }, (_, i) =>
        fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/file-${i}.js`),
      );
      try {
        await allArrived.promise;
      } finally {
        firstLookup.resolve({ host: "127.0.0.1", port: upstreamPort, token: "desk-token" });
      }
      const responses = await Promise.all(burst);
      expect(responses.every((res) => res.status === 200)).toBe(true);
      expect(resolveCalls).toBe(1);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("caches resolved endpoints until TTL expires and never caches misses", async () => {
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("asset-ok", { status: 200 }),
    });
    const upstreamPort = upstream.port!;

    let currentNow = 1_000;
    let resolveCalls = 0;

    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      endpointCacheTtlMs: 5_000,
      now: () => currentNow,
      resolve: async (computerId) => {
        resolveCalls += 1;
        if (computerId === "missing") return undefined;
        return { host: "127.0.0.1", port: upstreamPort, token: "desk-token" };
      },
    });

    try {
      const first = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/a.js`);
      const second = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/b.js`);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(resolveCalls).toBe(1);

      const miss1 = await fetch(`http://127.0.0.1:${proxy.port}/desktop/missing/`);
      const miss2 = await fetch(`http://127.0.0.1:${proxy.port}/desktop/missing/`);
      expect(miss1.status).toBe(404);
      expect(miss2.status).toBe(404);
      expect(resolveCalls).toBe(3);

      currentNow += 5_001;
      const refreshed = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/c.js`);
      expect(refreshed.status).toBe(200);
      expect(resolveCalls).toBe(4);
    } finally {
      proxy.stop();
      upstream.stop(true);
    }
  });

  test("invalidates cached endpoint and retries GET once when upstream restarts", async () => {
    const firstUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("old", { status: 200 }),
    });
    const secondUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("new", { status: 200 }),
    });
    const firstPort = firstUpstream.port!;
    const secondPort = secondUpstream.port!;

    let activePort = firstPort;
    let resolveCalls = 0;
    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      endpointCacheTtlMs: 60_000,
      resolve: async () => {
        resolveCalls += 1;
        return { host: "127.0.0.1", port: activePort, token: "desk-token" };
      },
    });

    try {
      const res1 = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/a.js`);
      expect(await res1.text()).toBe("old");
      expect(resolveCalls).toBe(1);

      firstUpstream.stop(true);
      activePort = secondPort;

      const res2 = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/a.js`);
      expect(res2.status).toBe(200);
      expect(await res2.text()).toBe("new");
      expect(resolveCalls).toBe(2);
    } finally {
      proxy.stop();
      firstUpstream.stop(true);
      secondUpstream.stop(true);
    }
  });

  test("does not let a pre-failure inflight lookup write a stale endpoint back into cache", async () => {
    const retryingReached = deferred<void>();
    const holdRetrying = deferred<void>();
    const firstUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        if (new URL(request.url).pathname === "/core/retrying.js") {
          retryingReached.resolve();
          await holdRetrying.promise;
        }
        return new Response("old", { status: 200 });
      },
    });
    const secondUpstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("new", { status: 200 }),
    });
    const firstPort = firstUpstream.port!;
    const secondPort = secondUpstream.port!;

    let currentNow = 1_000;
    let resolveCalls = 0;
    const staleLookupStarted = deferred<void>();
    const staleLookup = deferred<DesktopEndpoint | undefined>();

    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      endpointCacheTtlMs: 5_000,
      now: () => currentNow,
      resolve: async () => {
        resolveCalls += 1;
        if (resolveCalls === 1) {
          return { host: "127.0.0.1", port: firstPort, token: "desk-token" };
        }
        if (resolveCalls === 2) {
          staleLookupStarted.resolve();
          return staleLookup.promise;
        }
        return { host: "127.0.0.1", port: secondPort, token: "desk-token" };
      },
    });

    try {
      const warmup = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/a.js`);
      expect(await warmup.text()).toBe("old");

      const cachedInFlight = fetch(
        `http://127.0.0.1:${proxy.port}/desktop/computer-1/core/retrying.js`,
      );
      await retryingReached.promise;

      currentNow += 5_001;
      const staleRefresh = fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/stale.js`);
      await staleLookupStarted.promise;

      firstUpstream.stop(true);
      const retried = await cachedInFlight;
      expect(retried.status).toBe(200);
      expect(await retried.text()).toBe("new");

      staleLookup.resolve({ host: "127.0.0.1", port: firstPort, token: "desk-token" });
      await staleRefresh.catch(() => undefined);

      const next = await fetch(`http://127.0.0.1:${proxy.port}/desktop/computer-1/core/after.js`);
      expect(next.status).toBe(200);
      expect(await next.text()).toBe("new");
      expect(resolveCalls).toBe(3);
    } finally {
      holdRetrying.resolve();
      staleLookup.resolve(undefined);
      proxy.stop();
      firstUpstream.stop(true);
      secondUpstream.stop(true);
    }
  });

  test("closes browser websocket when pre-open frame queue exceeds bound", async () => {
    const holdUpgrade = deferred<void>();
    const upstream = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request, server) {
        await holdUpgrade.promise;
        if (server.upgrade(request)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message() {},
      },
    });
    const upstreamPort = upstream.port!;
    const proxy = startDesktopProxy({
      hostname: "127.0.0.1",
      port: 0,
      resolve: async () => ({ host: "127.0.0.1", port: upstreamPort, token: "desk-token" }),
    });

    try {
      const socket = new WebSocket(`ws://127.0.0.1:${proxy.port}/desktop/computer-1/websockify`);
      const closed = await new Promise<number>((resolve, reject) => {
        socket.addEventListener("open", () => {
          for (let i = 0; i < DESKTOP_WS_MAX_QUEUED_FRAMES + 5; i++) {
            socket.send("x");
          }
        });
        socket.addEventListener("close", (event) => resolve(event.code));
        socket.addEventListener("error", () => reject(new Error("unexpected error")));
      });
      expect(closed).toBe(1008);
    } finally {
      holdUpgrade.resolve();
      proxy.stop();
      upstream.stop(true);
    }
  });
});
