import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileStorage, LocalFileStorage } from "#src/server/files/file-storage.server";

test("local storage reads only the requested object prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-prefix-"));
  try {
    const storage = new LocalFileStorage(root);
    await storage.put("workspaces/w/attachments/a/original", new Blob(["abcdef"]));
    expect(
      await storage.readPrefix("workspaces/w/attachments/a/original", {
        maxBytes: 3,
        signal: new AbortController().signal,
      }),
    ).toEqual(new Uint8Array([97, 98, 99]));
    expect(
      await storage.readPrefix("workspaces/w/attachments/missing/original", {
        maxBytes: 3,
        signal: new AbortController().signal,
      }),
    ).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OSS honors cancellation while waiting for response headers or a stalled body", async () => {
  const releaseHeaders = Promise.withResolvers<Response>();
  const entered = { headers: Promise.withResolvers<void>(), body: Promise.withResolvers<void>() };
  const aborted = { headers: Promise.withResolvers<void>(), body: Promise.withResolvers<void>() };
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      const key = new URL(request.url).pathname === "/headers" ? "headers" : "body";
      request.signal.addEventListener("abort", () => aborted[key].resolve(), { once: true });
      entered[key].resolve();
      if (key === "headers") return releaseHeaders.promise;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
        { status: 206, headers: { "content-range": "bytes 0-9/10" } },
      );
    },
  });
  try {
    const storage = await createFileStorage({
      kind: "oss",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: server.url.origin,
      internal: false,
      accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
    });
    if (!storage.readPrefix) throw new Error("expected bounded prefix support");
    for (const key of ["headers", "body"] as const) {
      const controller = new AbortController();
      const reading = storage.readPrefix(key, { maxBytes: 10, signal: controller.signal });
      await entered[key].promise;
      controller.abort();
      await expect(reading).rejects.toThrow();
      await aborted[key].promise;
    }
    expect(requests).toBe(2);
  } finally {
    releaseHeaders.resolve(new Response("late"));
    server.stop(true);
  }
});

test("OSS rejects invalid range headers, oversized chunks and truncated bodies without retries", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      const key = new URL(request.url).pathname;
      return new Response(key === "/oversized" ? "abcdef" : "ab", {
        status: 206,
        headers: { "content-range": key === "/range" ? "bytes 1-3/6" : "bytes 0-2/6" },
      });
    },
  });
  try {
    const storage = await createFileStorage({
      kind: "oss",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: server.url.origin,
      internal: false,
      accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
    });
    if (!storage.readPrefix) throw new Error("expected bounded prefix support");
    for (const key of ["range", "oversized", "truncated"])
      await expect(
        storage.readPrefix(key, { maxBytes: 3, signal: new AbortController().signal }),
      ).rejects.toThrow();
    expect(requests).toBe(3);
  } finally {
    server.stop(true);
  }
});

test("OSS reads raw object bytes without decompressing beyond the range budget", async () => {
  const compressed = Bun.gzipSync(new Uint8Array(1024 * 1024));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(compressed, {
        status: 206,
        headers: {
          "content-range": `bytes 0-${compressed.length - 1}/${compressed.length}`,
          "content-encoding": "gzip",
        },
      });
    },
  });
  try {
    const storage = await createFileStorage({
      kind: "oss",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: server.url.origin,
      internal: false,
      accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
    });
    if (!storage.readPrefix) throw new Error("expected bounded prefix support");
    expect(
      await storage.readPrefix("compressed", {
        maxBytes: compressed.length,
        signal: new AbortController().signal,
      }),
    ).toEqual(compressed);
  } finally {
    server.stop(true);
  }
});

test("OSS prefix uses exactly one signed range GET and refuses a whole-object response", async () => {
  const requests: Array<{ key: string; range: string | null; behavior: string | null }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const key = new URL(request.url).pathname;
      requests.push({
        key,
        range: request.headers.get("range"),
        behavior: request.headers.get("x-oss-range-behavior"),
      });
      expect(new URL(request.url).searchParams.get("x-oss-signature-version")).toBe(
        "OSS4-HMAC-SHA256",
      );
      if (key === "/ignored") return new Response("abcdef");
      if (key === "/missing") return new Response(null, { status: 404 });
      return new Response("abc", { status: 206, headers: { "content-range": "bytes 0-2/6" } });
    },
  });
  try {
    const storage = await createFileStorage({
      kind: "oss",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: server.url.origin,
      internal: false,
      accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
    });
    if (!storage.readPrefix) throw new Error("expected bounded prefix support");
    const options = { maxBytes: 3, signal: new AbortController().signal };
    expect(await storage.readPrefix("valid", options)).toEqual(new Uint8Array([97, 98, 99]));
    await expect(storage.readPrefix("ignored", options)).rejects.toThrow();
    expect(await storage.readPrefix("missing", options)).toBeNull();
    expect(requests).toEqual(
      ["/valid", "/ignored", "/missing"].map((key) => ({
        key,
        range: "bytes=0-2",
        behavior: "standard",
      })),
    );
  } finally {
    server.stop(true);
  }
});
