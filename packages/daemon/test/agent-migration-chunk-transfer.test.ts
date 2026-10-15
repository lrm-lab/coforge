import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadAgentMigrationChunks,
  uploadAgentMigrationChunk,
} from "#src/agent-migration/chunk-transfer";
import {
  hasAgentMigrationChunk,
  readVerifiedAgentMigrationChunk,
  storeAgentMigrationChunk,
} from "#src/agent-migration/chunk-store";
import {
  AgentMigrationRemoteError,
  type AgentMigrationServer,
} from "#src/agent-migration/transfer-ports";
import { AgentMigrationTransferError } from "#src/agent-migration/transfer-error";
import { AgentMigrationBucketClient } from "#src/connection/agent-migration-bucket-client";

const roots: string[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const chunkOf = (index: number, text: string) => {
  const bytes = new TextEncoder().encode(text);
  return {
    index,
    offsetBytes: 0,
    sizeBytes: bytes.byteLength,
    sha256: Bun.CryptoHasher.hash("sha256", bytes, "hex"),
    bytes,
  };
};

/**
 * A fake migration bucket: PUT refuses to overwrite like OSS with `x-oss-forbid-overwrite`, GET
 * answers stored objects. `fail` makes the next requests for a key answer a status instead.
 */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const failures = new Map<string, number[]>();
  const stalled = new Set<string>();
  const requests: { method: string; key: string; headers: Headers }[] = [];
  let active = 0;
  let peak = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const key = new URL(request.url).pathname.slice(1);
      requests.push({ method: request.method, key, headers: request.headers });
      active++;
      peak = Math.max(peak, active);
      try {
        await Bun.sleep(2);
        if (stalled.has(key)) await new Promise(() => {});
        const failure = failures.get(key)?.shift();
        if (failure) return new Response("failed", { status: failure });
        if (request.method === "PUT") {
          if (objects.has(key)) return new Response("exists", { status: 409 });
          objects.set(key, new Uint8Array(await request.arrayBuffer()));
          return new Response(null, { status: 200 });
        }
        const object = objects.get(key);
        return object ? new Response(object) : new Response("missing", { status: 404 });
      } finally {
        active--;
      }
    },
  });
  servers.push(server);
  return {
    objects,
    requests,
    peak: () => peak,
    url: (key: string) => `http://127.0.0.1:${server.port}/${key}`,
    fail: (key: string, ...statuses: number[]) => failures.set(key, statuses),
    stall: (key: string) => stalled.add(key),
  };
}

/** A fake server API that signs bucket URLs per chunk and counts how often it was asked. */
function server(store: ReturnType<typeof bucket>, overrides: Partial<AgentMigrationServer> = {}) {
  const asked = { upload: 0, download: 0 };
  const api: AgentMigrationServer = {
    view: async () => {
      throw new Error("not used");
    },
    step: async () => {
      throw new Error("not used");
    },
    completeUpload: async () => {
      throw new Error("not used");
    },
    fail: async () => {
      throw new Error("not used");
    },
    uploadUrl: async (input) => {
      asked.upload++;
      return {
        url: store.url(`chunks/${input.chunk.index}`),
        headers: { "x-oss-forbid-overwrite": "true" },
      };
    },
    downloadUrl: async (input) => {
      asked.download++;
      return { url: store.url(`chunks/${input.index}`) };
    },
    ...overrides,
  };
  return { api, asked, ports: { server: api, bucket: new AgentMigrationBucketClient() } };
}

const ids = { migrationId: "migration-1", generation: 1 };
const soon = () => Date.now() + 5_000;

test("an uploaded chunk is PUT with the signed headers; one the bucket already has is done", async () => {
  const store = bucket();
  const { ports } = server(store);
  const chunk = chunkOf(0, "chunk zero");
  await uploadAgentMigrationChunk(ports, { ...ids, chunk, deadline: soon() });
  expect(store.objects.get("chunks/0")).toEqual(chunk.bytes);
  expect(store.requests[0]!.headers.get("x-oss-forbid-overwrite")).toBe("true");
  // A retry after a lost reply: the bucket refuses to overwrite, which means it is there.
  await uploadAgentMigrationChunk(ports, { ...ids, chunk, deadline: soon() });
  expect(store.requests.map((request) => request.method)).toEqual(["PUT", "PUT"]);
});

test("an upload retries transient failures with a freshly signed URL each time", async () => {
  const store = bucket();
  const { ports, asked } = server(store);
  store.fail("chunks/0", 503, 429, 500);
  const chunk = chunkOf(0, "chunk zero");
  await uploadAgentMigrationChunk(ports, { ...ids, chunk, deadline: soon() });
  expect(store.objects.get("chunks/0")).toEqual(chunk.bytes);
  expect(asked.upload).toBe(4);
});

test("a bucket that forbids a freshly signed URL is refused at once, not retried", async () => {
  const store = bucket();
  const { ports, asked } = server(store);
  store.fail("chunks/0", 403);
  await expect(
    uploadAgentMigrationChunk(ports, { ...ids, chunk: chunkOf(0, "x"), deadline: soon() }),
  ).rejects.toMatchObject({ code: "bucket_refused", retryable: false });
  expect(asked.upload).toBe(1);
});

test("a request that stalls is cut off at the deadline", async () => {
  const store = bucket();
  store.stall("chunks/0");
  const deadline = Date.now() + 150;
  await expect(
    uploadAgentMigrationChunk(server(store).ports, { ...ids, chunk: chunkOf(0, "x"), deadline }),
  ).rejects.toMatchObject({ code: "lease_expired" });
  expect(Date.now() - deadline).toBeLessThan(1_000);
});

test("an upload stops at the deadline, and at once on a refusal it cannot retry", async () => {
  const store = bucket();
  store.fail("chunks/0", ...Array.from({ length: 1000 }, () => 503));
  const deadline = Date.now() + 200;
  const failed = uploadAgentMigrationChunk(server(store).ports, {
    ...ids,
    chunk: chunkOf(0, "x"),
    deadline,
  });
  await expect(failed).rejects.toMatchObject({ code: "lease_expired" });
  expect(Date.now()).toBeGreaterThanOrEqual(deadline);

  const refusing = server(store, {
    uploadUrl: async () => {
      throw new AgentMigrationRemoteError("invalid_state", false);
    },
  });
  const refused = uploadAgentMigrationChunk(refusing.ports, {
    ...ids,
    chunk: chunkOf(1, "y"),
    deadline: soon(),
  });
  await expect(refused).rejects.toBeInstanceOf(AgentMigrationRemoteError);
});

async function migrationDirectory() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "agent-migration-transfer-"));
  roots.push(root);
  return root;
}

test("the target downloads only the chunks it lacks, three at a time, each verified and kept", async () => {
  const store = bucket();
  const { ports, asked } = server(store);
  const chunks = Array.from({ length: 8 }, (_, index) => chunkOf(index, `chunk ${index}`));
  for (const chunk of chunks) store.objects.set(`chunks/${chunk.index}`, chunk.bytes);
  const directory = await migrationDirectory();
  await storeAgentMigrationChunk(directory, chunks[2]!, chunks[2]!.bytes);
  store.fail("chunks/5", 404, 500);
  await downloadAgentMigrationChunks(ports, {
    ...ids,
    chunks,
    migrationDirectory: directory,
    deadline: soon(),
  });
  for (const chunk of chunks)
    expect(await readVerifiedAgentMigrationChunk(directory, chunk)).toEqual(chunk.bytes);
  expect(store.requests.some((request) => request.key === "chunks/2")).toBe(false);
  expect(asked.download).toBe(7 + 2);
  expect(store.peak()).toBeLessThanOrEqual(3);
});

test("the first failed chunk stops the other downloads, and nothing is written after it", async () => {
  const store = bucket();
  const chunks = Array.from({ length: 6 }, (_, index) => chunkOf(index, `chunk ${index}`));
  for (const chunk of chunks) store.objects.set(`chunks/${chunk.index}`, chunk.bytes);
  store.fail("chunks/0", 400);
  store.stall("chunks/1");
  store.fail("chunks/2", ...Array.from({ length: 1000 }, () => 503));
  const directory = await migrationDirectory();
  await expect(
    downloadAgentMigrationChunks(server(store).ports, {
      ...ids,
      chunks,
      migrationDirectory: directory,
      deadline: soon(),
    }),
  ).rejects.toMatchObject({ code: "bucket_refused" });
  const settled = store.requests.length;
  await Bun.sleep(100);
  expect(store.requests.length).toBe(settled);
  for (const chunk of chunks) expect(await hasAgentMigrationChunk(directory, chunk)).toBe(false);
});

test("a chunk the bucket serves at the wrong size is refused before its body is read", async () => {
  const store = bucket();
  const chunk = chunkOf(0, "the real chunk");
  store.objects.set("chunks/0", new TextEncoder().encode("longer than the real chunk"));
  await expect(
    downloadAgentMigrationChunks(server(store).ports, {
      ...ids,
      chunks: [chunk],
      migrationDirectory: await migrationDirectory(),
      deadline: soon(),
    }),
  ).rejects.toMatchObject({ code: "size_mismatch", retryable: false });
});

test("a chunk the bucket serves with the wrong bytes fails the download and is not kept", async () => {
  const store = bucket();
  const chunk = chunkOf(0, "the real chunk");
  store.objects.set("chunks/0", new TextEncoder().encode("the fake chunk"));
  const directory = await migrationDirectory();
  const failed = downloadAgentMigrationChunks(server(store).ports, {
    ...ids,
    chunks: [chunk],
    migrationDirectory: directory,
    deadline: soon(),
  });
  await expect(failed).rejects.toMatchObject({ code: "chunk_digest_mismatch" });
  expect(await hasAgentMigrationChunk(directory, chunk)).toBe(false);
});

test("an abort stops a transfer between attempts", async () => {
  const store = bucket();
  store.fail("chunks/0", ...Array.from({ length: 1000 }, () => 503));
  const controller = new AbortController();
  const failed = uploadAgentMigrationChunk(server(store).ports, {
    ...ids,
    chunk: chunkOf(0, "x"),
    deadline: soon(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await expect(failed).rejects.toBeInstanceOf(AgentMigrationTransferError);
  await expect(failed).rejects.toMatchObject({ code: "aborted" });
});

test("an abort while a request is in flight still reads as aborted", async () => {
  const controller = new AbortController();
  const hanging = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
  servers.push(hanging);
  const { ports } = server(bucket(), {
    uploadUrl: async () => ({ url: `http://127.0.0.1:${hanging.port}/chunk`, headers: {} }),
  });
  const failed = uploadAgentMigrationChunk(ports, {
    ...ids,
    chunk: chunkOf(0, "x"),
    deadline: soon(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await expect(failed).rejects.toMatchObject({ code: "aborted" });
});
