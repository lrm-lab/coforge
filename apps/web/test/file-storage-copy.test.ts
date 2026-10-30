import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  createFileStorage,
  LocalFileStorage,
  type ManagedFileStorage,
} from "#src/server/files/file-storage.server";

/** Copying an object inside the store: the independent copy a forwarded message's file is. */
describe("local file storage copy", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coforge-files-copy-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("copies an object to an independent key; removing either leaves the other", async () => {
    const storage = new LocalFileStorage(root);
    const from = "workspaces/w/attachments/copy-a/original";
    const to = "workspaces/w/attachments/copy-b/original";
    await storage.put(from, new Blob(["forward me"]), "text/plain");
    await storage.copyObject(from, to);
    expect(await new Response((await storage.open(to))!.body).text()).toBe("forward me");
    await storage.remove(from);
    expect(await storage.open(from)).toBeNull();
    expect(await new Response((await storage.open(to))!.body).text()).toBe("forward me");
    await storage.remove(to);
  });

  test("refuses a missing source and an existing destination", async () => {
    const storage = new LocalFileStorage(root);
    const key = "workspaces/w/attachments/only/original";
    await expect(
      storage.copyObject("workspaces/w/attachments/none/original", key),
    ).rejects.toThrow();
    expect(await storage.open(key)).toBeNull();
    await storage.put(key, new Blob(["x"]), "text/plain");
    await expect(storage.copyObject(key, key)).rejects.toThrow();
    await storage.remove(key);
  });
});

describe("oss file storage copy", () => {
  const objects = new Map<string, string>();
  const requests: Array<{ method: string; key: string; headers: Headers }> = [];
  let server: ReturnType<typeof Bun.serve>;
  let storage: ManagedFileStorage;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const key = new URL(request.url).pathname.slice(1);
        requests.push({ method: request.method, key, headers: request.headers });
        const source = request.headers.get("x-oss-copy-source");
        if (request.method !== "PUT" || !source) return ossError(405, "MethodNotAllowed");
        const original = objects.get(decodeURIComponent(source).replace(/^\/[^/]+\//, ""));
        if (original === undefined) return ossError(404, "NoSuchKey");
        if (objects.has(key) && request.headers.get("x-oss-forbid-overwrite") === "true")
          return ossError(409, "FileAlreadyExists");
        objects.set(key, original);
        return new Response(
          '<CopyObjectResult><ETag>"1"</ETag><LastModified>2026-01-01T00:00:00.000Z</LastModified></CopyObjectResult>',
          { headers: { "content-type": "application/xml" } },
        );
      },
    });
    storage = await createFileStorage({
      kind: "oss",
      bucket: "coforge-files-test",
      region: "cn-beijing",
      endpoint: `http://127.0.0.1:${server.port}`,
      internal: false,
      accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
    });
  });
  afterAll(() => server.stop(true));

  test("copies server-side under the no-overwrite guard", async () => {
    objects.set("workspaces/w/attachments/a/original", "bytes");
    await storage.copyObject(
      "workspaces/w/attachments/a/original",
      "workspaces/w/attachments/b/original",
    );
    const copy = requests.find((r) => r.key === "workspaces/w/attachments/b/original");
    expect(copy?.headers.get("x-oss-forbid-overwrite")).toBe("true");
    expect(objects.get("workspaces/w/attachments/b/original")).toBe("bytes");
    await expect(
      storage.copyObject(
        "workspaces/w/attachments/a/original",
        "workspaces/w/attachments/b/original",
      ),
    ).rejects.toMatchObject({ code: "FileAlreadyExists" });
    await expect(
      storage.copyObject(
        "workspaces/w/attachments/none/original",
        "workspaces/w/attachments/c/original",
      ),
    ).rejects.toMatchObject({ code: "NoSuchKey" });
  });

  function ossError(status: number, code: string) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><RequestId>r</RequestId></Error>`,
      { status, headers: { "content-type": "application/xml", "x-oss-request-id": "r" } },
    );
  }
});
