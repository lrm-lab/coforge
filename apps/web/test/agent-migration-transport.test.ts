import { expect, test } from "bun:test";
import { AgentMigrations } from "#src/server/agent-migrations/agent-migrations.server";
import {
  AgentMigrationTransport,
  agentMigrationChunkKey,
  type AgentMigrationObjectStore,
} from "#src/server/agent-migrations/agent-migration-transport.server";
import { memoryStore } from "./helpers/agent-migration-memory-store";

const workspaceId = "workspace-1";
const source = { workspaceId, computerId: "computer-a" };
const target = { workspaceId, computerId: "computer-b" };
const stranger = { workspaceId, computerId: "computer-z" };

const chunk = (index: number, offsetBytes: number, sizeBytes: number) => ({
  index,
  offsetBytes,
  sizeBytes,
  sha256: String(index).padStart(64, "0"),
});

const MANIFEST = {
  format: "tar+gzip" as const,
  contentType: "application/vnd.coforge.agent-migration-bundle+tar+gzip" as const,
  entryCount: 2,
  expandedBytes: 30,
  maxEntryBytes: 20,
  memoryMdPresent: true,
  notesPresent: false,
  sizeBytes: 1024 * 1024 + 4,
  sha256: "f".repeat(64),
  chunkSizeBytes: 1024 * 1024,
  chunks: [chunk(0, 0, 1024 * 1024), chunk(1, 1024 * 1024, 4)],
};

/** A fake bucket: a presigned PUT stands in for the upload, so `head` then finds the object. */
function objects(): AgentMigrationObjectStore & { puts: string[]; sizes: Map<string, number> } {
  const puts: string[] = [];
  const sizes = new Map<string, number>();
  return {
    puts,
    sizes,
    head: async (key) => (sizes.has(key) ? { sizeBytes: sizes.get(key)! } : null),
    presignPut: async (key, input) => {
      puts.push(key);
      return {
        url: `https://oss.test/put/${key}?expires=${input.expiresInSeconds}`,
        headers: { "x-oss-forbid-overwrite": "true" },
      };
    },
    presignGet: async (key) => `https://oss.test/get/${key}`,
  };
}

async function setup(objectStore: AgentMigrationObjectStore | null = objects()) {
  const fixture = memoryStore();
  const migrations = new AgentMigrations(fixture.store);
  const created = await migrations.request({
    workspaceId,
    agentId: "agent-1",
    targetComputerId: "computer-b",
    requestedByUserId: "user-1",
  });
  if (created.status !== "created") throw new Error(created.status);
  const transport = new AgentMigrationTransport(migrations, objectStore);
  const id = created.migration.id;
  const revision = async () => (await migrations.view(source, id))!.revision;
  return { transport, migrations, id, revision, objectStore, ...fixture };
}

async function stopSource(context: Awaited<ReturnType<typeof setup>>) {
  return context.transport.step(source, {
    migrationId: context.id,
    generation: 1,
    expectedRevision: await context.revision(),
    step: "source_stopped",
  });
}

test("each Computer sees the migration from its own role; anyone else sees nothing", async () => {
  const { transport, id } = await setup();
  expect(await transport.view(source, id)).toMatchObject({
    migration: { id, agentId: "agent-1", role: "source", state: "requested", generation: 1 },
    manifest: null,
  });
  expect(await transport.view(target, id)).toMatchObject({ migration: { role: "target" } });
  expect(await transport.view(stranger, id)).toBeNull();
});

test("the source gets presigned uploads, keyed by chunk digest, only once it has stopped the Agent", async () => {
  const context = await setup();
  const { transport, id, objectStore } = context;
  const input = { migrationId: id, generation: 1, chunk: chunk(0, 0, 8) };
  expect(await transport.uploadUrl(source, input)).toEqual({
    status: "refused",
    code: "invalid_state",
  });
  await stopSource(context);
  const issued = await transport.uploadUrl(source, input);
  const key = agentMigrationChunkKey({
    workspaceId,
    agentId: "agent-1",
    migrationId: id,
    generation: 1,
    ...input.chunk,
  });
  expect(key).toBe(
    `workspaces/${workspaceId}/agents/agent-1/migrations/${id}/1/chunks/0-${input.chunk.sha256}`,
  );
  expect(issued).toMatchObject({
    status: "ok",
    url: expect.stringContaining(key),
    headers: { "x-oss-forbid-overwrite": "true" },
  });
  expect(await transport.uploadUrl(target, input)).toEqual({
    status: "refused",
    code: "wrong_computer",
  });
  expect(await transport.uploadUrl(source, { ...input, generation: 2 })).toEqual({
    status: "refused",
    code: "stale_generation",
  });
  expect(
    await transport.uploadUrl(source, { ...input, chunk: { ...input.chunk, sha256: "nope" } }),
  ).toEqual({ status: "refused", code: "invalid_chunk" });
  expect((objectStore as ReturnType<typeof objects>).puts).toEqual([key]);
});

const keyOf = (id: string, entry: { index: number; sha256: string }) =>
  agentMigrationChunkKey({
    workspaceId,
    agentId: "agent-1",
    migrationId: id,
    generation: 1,
    ...entry,
  });

async function upload(context: Awaited<ReturnType<typeof setup>>) {
  const bucket = context.objectStore as ReturnType<typeof objects>;
  for (const entry of MANIFEST.chunks) bucket.sizes.set(keyOf(context.id, entry), entry.sizeBytes);
  return context.transport.completeUpload(source, {
    migrationId: context.id,
    generation: 1,
    expectedRevision: await context.revision(),
    manifest: MANIFEST,
  });
}

test("completing the upload stores a valid manifest; the target then gets a download per chunk", async () => {
  const context = await setup();
  const { transport, id } = context;
  await stopSource(context);
  expect(await upload(context)).toMatchObject({
    status: "advanced",
    migration: { state: "uploaded" },
  });
  expect((await transport.view(target, id))!.manifest).toEqual(MANIFEST);
  const input = { migrationId: id, generation: 1, index: 1 };
  expect(await transport.downloadUrl(target, input)).toEqual({
    status: "ok",
    url: `https://oss.test/get/${keyOf(id, MANIFEST.chunks[1]!)}`,
  });
  expect(await transport.downloadUrl(target, { ...input, index: 2 })).toEqual({
    status: "refused",
    code: "invalid_chunk",
  });
  // The source never needs the downloads.
  expect(await transport.downloadUrl(source, input)).toEqual({
    status: "refused",
    code: "wrong_computer",
  });
});

test("a manifest is accepted only once every chunk it names is in the bucket at its size", async () => {
  const context = await setup();
  await stopSource(context);
  const bucket = context.objectStore as ReturnType<typeof objects>;
  const complete = async () =>
    context.transport.completeUpload(source, {
      migrationId: context.id,
      generation: 1,
      expectedRevision: await context.revision(),
      manifest: MANIFEST,
    });
  bucket.sizes.set(keyOf(context.id, MANIFEST.chunks[0]!), MANIFEST.chunks[0]!.sizeBytes);
  expect(await complete()).toEqual({ status: "refused", code: "chunks_missing" });
  bucket.sizes.set(keyOf(context.id, MANIFEST.chunks[1]!), 3);
  expect(await complete()).toEqual({ status: "refused", code: "chunks_missing" });
  bucket.sizes.set(keyOf(context.id, MANIFEST.chunks[1]!), 4);
  expect(await complete()).toMatchObject({ status: "advanced" });
});

test("downloads end with the transfer", async () => {
  const context = await setup();
  await stopSource(context);
  await upload(context);
  await context.transport.fail(target, {
    migrationId: context.id,
    generation: 1,
    errorCode: "download_failed",
  });
  expect(
    await context.transport.downloadUrl(target, {
      migrationId: context.id,
      generation: 1,
      index: 0,
    }),
  ).toEqual({ status: "refused", code: "invalid_state" });
});

test("completion preserves state fencing and applied retries when chunks are absent", async () => {
  const context = await setup();
  const complete = (generation: number, expectedRevision: number) =>
    context.transport.completeUpload(source, {
      migrationId: context.id,
      generation,
      expectedRevision,
      manifest: MANIFEST,
    });
  expect(await complete(1, 0)).toEqual({ status: "refused", code: "invalid_transition" });
  await stopSource(context);
  expect(await complete(2, 1)).toEqual({ status: "refused", code: "stale_generation" });
  expect(await complete(1, 0)).toEqual({ status: "refused", code: "stale_revision" });
  expect(await upload(context)).toMatchObject({ status: "advanced" });
  (context.objectStore as ReturnType<typeof objects>).sizes.clear();
  expect(await complete(1, 1)).toMatchObject({
    status: "already_applied",
    migration: { state: "uploaded", revision: 2 },
  });
});

test("completion cannot skip missing chunks when the source stops during its first read", async () => {
  const context = await setup();
  const find = context.store.find;
  let stopDuringRead = true;
  context.store.find = async (id) => {
    const snapshot = await find(id);
    if (stopDuringRead) {
      stopDuringRead = false;
      await stopSource(context);
    }
    return snapshot;
  };
  expect(
    await context.transport.completeUpload(source, {
      migrationId: context.id,
      generation: 1,
      expectedRevision: 1,
      manifest: MANIFEST,
    }),
  ).toEqual({ status: "refused", code: "stale_revision" });
  expect(await context.transport.view(source, context.id)).toMatchObject({
    migration: { state: "source_stopped", revision: 1 },
    manifest: null,
  });
});

test("refuses a manifest whose chunks do not line up with the bundle", async () => {
  const context = await setup();
  await stopSource(context);
  const base = {
    migrationId: context.id,
    generation: 1,
    expectedRevision: await context.revision(),
  };
  for (const manifest of [
    { ...MANIFEST, chunks: [chunk(0, 0, 1024 * 1024), chunk(2, 1024 * 1024, 4)] },
    { ...MANIFEST, chunks: [chunk(0, 0, 1024 * 1024), chunk(1, 1024 * 1024 + 1, 3)] },
    { ...MANIFEST, chunks: [chunk(0, 0, 1024), chunk(1, 1024, 1024 * 1024 + 4 - 1024)] },
    { ...MANIFEST, sizeBytes: MANIFEST.sizeBytes + 1 },
    { ...MANIFEST, chunkSizeBytes: 1024, chunks: [chunk(0, 0, MANIFEST.sizeBytes)] },
    { ...MANIFEST, maxEntryBytes: MANIFEST.expandedBytes + 1 },
    { ...MANIFEST, unexpected: true },
    {
      ...MANIFEST,
      chunks: Array.from({ length: 2049 }, (_, index) => chunk(index, index, 1)),
      sizeBytes: 2049,
    },
    { ...MANIFEST, format: "zip" },
  ])
    expect(await context.transport.completeUpload(source, { ...base, manifest })).toEqual({
      status: "refused",
      code: "invalid_manifest",
    });
});

test("without a migration bucket the transfer is unavailable", async () => {
  const context = await setup(null);
  await stopSource(context);
  expect(
    await context.transport.uploadUrl(source, {
      migrationId: context.id,
      generation: 1,
      chunk: chunk(0, 0, 8),
    }),
  ).toEqual({
    status: "refused",
    code: "unavailable",
  });
});

test("steps and failures pass through the state machine's own rules", async () => {
  const context = await setup();
  const { transport, id } = context;
  expect(
    await transport.step(target, {
      migrationId: id,
      generation: 1,
      expectedRevision: 0,
      step: "source_stopped",
    }),
  ).toEqual({
    status: "refused",
    code: "wrong_computer",
  });
  expect(
    await transport.fail(target, {
      migrationId: id,
      generation: 1,
      errorCode: "download_failed",
      errorDetail: "chunk 3",
    }),
  ).toMatchObject({
    status: "failed",
    migration: { state: "failed", errorCode: "download_failed" },
  });
});
