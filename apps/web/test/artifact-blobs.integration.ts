import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts, ARTIFACT_TEXT_LIMIT } from "#src/server/artifacts/artifacts.server";
import {
  ARTIFACT_BLOB_GRACE_MS,
  StoredArtifactBlobs,
} from "#src/server/artifacts/artifact-blobs.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

/**
 * Where an artifact's bytes live (task #385): one object per Workspace and sha256, in the same
 * private bucket as attachments, under the Workspace's prefix so a Workspace delete removes them.
 * A blob no version names is removed a day after its upload; one any version names, however old,
 * never is.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let storage: LocalFileStorage;
let blobs: StoredArtifactBlobs;
let artifacts: Artifacts;
let workspaceId: string;
let otherWorkspaceId: string;
let userId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-blobs-"));
  storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  userId = (await db.user.create({ data: { username: `ab-${handle}`, displayName: "Blobs" } })).id;
  const workspace = (slug: string) =>
    db.workspace.create({
      data: { slug, name: slug, members: { create: { userId, role: "owner" } } },
    });
  workspaceId = (await workspace(`ab-${handle}`)).id;
  otherWorkspaceId = (await workspace(`ab-other-${handle}`)).id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const sha256Of = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const text = (value: string) => new TextEncoder().encode(value);
/** The object a stored blob's row names. */
const objectOf = async (workspace: string, sha256: string) =>
  (
    await db.artifactBlob.findUniqueOrThrow({
      where: { workspaceId_sha256: { workspaceId: workspace, sha256 } },
      select: { objectKey: true },
    })
  ).objectKey;
const exists = async (objectKey: string) => (await storage.open(objectKey)) !== null;
/** Moves a blob's last use back in time, as if it had waited that long. */
const age = (workspace: string, sha256: string, ms: number) =>
  db.artifactBlob.update({
    where: { workspaceId_sha256: { workspaceId: workspace, sha256 } },
    data: { lastUsedAt: new Date(Date.now() - ms) },
  });

test("an upload is stored once by its sha256, with the size and kind its bytes have", async () => {
  const bytes = text(`# Notes ${handle}\n`);
  const first = await blobs.upload({ workspaceId, bytes });
  expect(first).toEqual({ sha256: sha256Of(bytes), sizeBytes: bytes.length, kind: "text" });
  expect(await blobs.upload({ workspaceId, bytes, sha256: sha256Of(bytes) })).toEqual(first);
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256: first.sha256 } })).toBe(1);
  const objectKey = await objectOf(workspaceId, first.sha256);
  expect(objectKey.startsWith(`workspaces/${workspaceId}/artifacts/`)).toBe(true);
  const opened = await blobs.open(workspaceId, first.sha256);
  expect(new Uint8Array(await new Response(opened!.body).arrayBuffer())).toEqual(bytes);

  // Bytes that are not UTF-8 text, or carry a NUL, are binary.
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  expect((await blobs.upload({ workspaceId, bytes: image })).kind).toBe("binary");
  // A claimed sha256 the bytes do not have is refused, and nothing is stored.
  await expect(
    blobs.upload({ workspaceId, bytes: text("other"), sha256: first.sha256 }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-blob-sha256" });
  const inspected = await blobs.inspectMany(workspaceId, [first.sha256, "0".repeat(64)]);
  expect([...inspected.keys()]).toEqual([first.sha256]);
  expect(inspected.get(first.sha256)).toEqual({ sizeBytes: bytes.length, kind: "text" });
});

test("an upload larger than a file may be is refused before anything is stored", async () => {
  const tooBig = new Uint8Array(ARTIFACT_TEXT_LIMIT + 1).fill(0x61);
  await expect(blobs.upload({ workspaceId, bytes: tooBig })).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-file-too-large",
  });
  expect(await db.artifactBlob.count({ where: { workspaceId, sizeBytes: tooBig.length } })).toBe(0);
});

test("a blob no version names goes a day after its upload; one any version names stays", async () => {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `kept-${handle}`,
    kind: "markdown",
    entryPath: "document.md",
    author: { userId },
  });
  const save = async (content: string, baseVersion: number) => {
    const blob = await blobs.upload({ workspaceId, bytes: text(content), actor: { userId } });
    await artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion,
      publisher: { userId },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "document.md", sha256: blob.sha256 }],
    });
    return blob.sha256;
  };
  // Version 1's file is replaced in version 2, so only an old version names it now.
  const old = await save(`first ${handle}`, 0);
  const current = await save(`second ${handle}`, 1);
  const unused = (await blobs.upload({ workspaceId, bytes: text(`unused ${handle}`) })).sha256;
  const fresh = (await blobs.upload({ workspaceId, bytes: text(`fresh ${handle}`) })).sha256;
  // The same bytes as a used file, but in another Workspace, where no version names them.
  const elsewhere = (
    await blobs.upload({ workspaceId: otherWorkspaceId, bytes: text(`first ${handle}`) })
  ).sha256;
  const day = ARTIFACT_BLOB_GRACE_MS + 60_000;
  for (const sha256 of [old, current, unused]) await age(workspaceId, sha256, day);
  await age(otherWorkspaceId, elsewhere, day);
  const objects = {
    old: await objectOf(workspaceId, old),
    current: await objectOf(workspaceId, current),
    fresh: await objectOf(workspaceId, fresh),
    unused: await objectOf(workspaceId, unused),
    elsewhere: await objectOf(otherWorkspaceId, elsewhere),
  };

  await blobs.removeUnreferenced();

  const kept = async (workspace: string, sha256: string) =>
    (await db.artifactBlob.count({ where: { workspaceId: workspace, sha256 } })) === 1;
  expect(await kept(workspaceId, old)).toBe(true);
  expect(await kept(workspaceId, current)).toBe(true);
  expect(await kept(workspaceId, fresh)).toBe(true);
  expect(await kept(workspaceId, unused)).toBe(false);
  expect(await kept(otherWorkspaceId, elsewhere)).toBe(false);
  expect(await exists(objects.old)).toBe(true);
  expect(await exists(objects.current)).toBe(true);
  expect(await exists(objects.fresh)).toBe(true);
  expect(await exists(objects.unused)).toBe(false);
  expect(await exists(objects.elsewhere)).toBe(false);
});

test("a sweep while a save naming the blob is open leaves the blob to that save", async () => {
  const blob = await blobs.upload({ workspaceId, bytes: text(`racing ${handle}`) });
  await age(workspaceId, blob.sha256, ARTIFACT_BLOB_GRACE_MS + 60_000);
  let swept = -1;
  await db.$transaction(async (tx) => {
    expect(await blobs.use(tx, workspaceId, [blob.sha256])).toEqual([]);
    // Another connection sweeps while the save holds the row: it passes over it.
    swept = await blobs.removeUnreferenced();
  });
  expect(swept).toBe(0);
  const row = await db.artifactBlob.findUniqueOrThrow({
    where: { workspaceId_sha256: { workspaceId, sha256: blob.sha256 } },
    select: { referenced: true },
  });
  expect(row.referenced).toBe(true);
  // Named by a save now, it is never looked at again, however old.
  await age(workspaceId, blob.sha256, 30 * ARTIFACT_BLOB_GRACE_MS);
  await blobs.removeUnreferenced();
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256: blob.sha256 } })).toBe(1);
});

test("a save naming a blob that was removed meanwhile is told to upload it again", async () => {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `late-${handle}`,
    kind: "markdown",
    entryPath: "document.md",
    author: { userId },
  });
  const blob = await blobs.upload({
    workspaceId,
    bytes: text(`late ${handle}`),
    actor: { userId },
  });
  await age(workspaceId, blob.sha256, ARTIFACT_BLOB_GRACE_MS + 60_000);
  await blobs.removeUnreferenced();
  expect(
    await artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 0,
      publisher: { userId },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "document.md", sha256: blob.sha256 }],
    }),
  ).toEqual({ status: "missing", missing: [blob.sha256] });
});
