import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  Artifacts,
  ARTIFACT_BINARY_LIMIT,
  ARTIFACT_FILE_LIMIT,
  ARTIFACT_TEXT_LIMIT,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
} from "#src/server/artifacts/artifacts.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;

const blobs = new Map<string, ArtifactBlobInfo>();
let inspections = 0;
const store: ArtifactBlobStore = {
  inspectMany: async (_workspaceId, sha256s) => {
    inspections += 1;
    return new Map(
      sha256s.flatMap((sha256) => (blobs.has(sha256) ? [[sha256, blobs.get(sha256)!]] : [])),
    );
  },
  use: async (_tx, _workspaceId, sha256s) => sha256s.filter((sha256) => !blobs.has(sha256)),
  // No bytes are stored here: a line merge of documents is `artifact-merge.integration.ts`'s.
  read: async () => null,
  allowed: async (_workspaceId, _artifactId, _actor, sha256s) => new Set(sha256s),
  upload: async () => {
    throw new Error("no bytes are stored in this test");
  },
};
const artifacts = new Artifacts(db, store, { enabled: async () => true });

const blob = (sha256: string, kind = "text", sizeBytes = 10) =>
  blobs.set(sha256, { kind, sizeBytes });
const file = (path: string, sha256: string) => ({ path, sha256 });

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `artifact-${handle}`, displayName: "Artifact User" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: {
      slug: `artifacts-${handle}`,
      name: "Artifacts",
      members: { create: { userId, role: "owner" } },
    },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

const create = (name: string, entryPath = "index.md", kind = "markdown") =>
  artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `${name}-${handle}`,
    kind,
    entryPath,
    author: { userId },
  });

test("an artifact's live name is unique, and a soft delete releases it", async () => {
  const created = await create("page");
  await expect(create("page")).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-name-taken",
  });
  await db.artifact.update({ where: { id: created.id }, data: { deletedAt: new Date() } });
  const again = await create("page");
  expect(again.name).toBe(created.name);
});

test("a push inherits unlisted files and records what changed", async () => {
  blob("sha-a");
  blob("sha-b");
  blob("sha-c");
  const artifact = await create("push");
  const first = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "push-1",
    files: [file("index.md", "sha-a"), file("notes.txt", "sha-b")],
  });
  expect(first).toMatchObject({ status: "created", number: 1 });

  const second = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 1,
    publisher: { userId },
    idempotencyKey: "push-2",
    files: [file("index.md", "sha-c")],
    deletedPaths: ["notes.txt"],
  });
  expect(second).toMatchObject({ status: "created", number: 2 });

  const read = await artifacts.read({ workspaceId, reader: { userId }, artifactId: artifact.id });
  expect(read.files.map((entry) => entry.path)).toEqual(["index.md"]);
  expect(read.files[0]!.sha256).toBe("sha-c");
  const old = await artifacts.read({
    workspaceId,
    reader: { userId },
    artifactId: artifact.id,
    version: 1,
  });
  expect(old.files.map((entry) => entry.path)).toEqual(["index.md", "notes.txt"]);
});

test("a push over an older base merges others' files, and conflicts on the same file", async () => {
  blob("sha-1");
  blob("sha-2");
  blob("sha-3");
  blob("sha-4");
  // A file set, not a document: the same file on both sides is merged only by a human here
  // (a document merges line by line, `artifact-merge.integration.ts`).
  const artifact = await create("merge", "index.md", "other");
  await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "merge-0",
    files: [file("index.md", "sha-1")],
  });
  // Someone else adds notes.txt (version 2).
  await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 1,
    publisher: { userId },
    idempotencyKey: "merge-1",
    files: [file("notes.txt", "sha-2")],
  });
  // This push still believes it is on version 1 and changes index.md: the two changes merge.
  const merged = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 1,
    publisher: { userId },
    idempotencyKey: "merge-2",
    files: [file("index.md", "sha-3")],
  });
  expect(merged).toMatchObject({ status: "created", number: 3, merged: ["notes.txt"] });
  const read = await artifacts.read({ workspaceId, reader: { userId }, artifactId: artifact.id });
  expect(read.files.map((entry) => entry.path)).toEqual(["index.md", "notes.txt"]);

  // The same file on both sides cannot be merged.
  await expect(
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 2,
      publisher: { userId },
      idempotencyKey: "merge-3",
      files: [file("index.md", "sha-4")],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", errorId: "artifact-base-moved" });

  // Nothing of this push's own: nothing to push, even though the artifact moved.
  expect(
    await artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 2,
      publisher: { userId },
      idempotencyKey: "merge-4",
    }),
  ).toEqual({ status: "nothing" });
});

test("concurrent pushes serialize: each gets its version, or a replay — never a raw unique error", async () => {
  blob("sha-x");
  blob("sha-y");
  const artifact = await create("concurrent");
  await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "concurrent-0",
    files: [file("index.md", "sha-x")],
  });
  const [first, second] = await Promise.all([
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 1,
      publisher: { userId },
      idempotencyKey: "concurrent-1",
      files: [file("a.txt", "sha-y")],
    }),
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 1,
      publisher: { userId },
      idempotencyKey: "concurrent-1",
      files: [file("a.txt", "sha-y")],
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual(["created", "replayed"]);
  const read = await artifacts.read({ workspaceId, reader: { userId }, artifactId: artifact.id });
  expect(read.files.map((entry) => entry.path).sort()).toEqual(["a.txt", "index.md"]);
});

test("size and kind come from the blob, not the request", async () => {
  blob("sha-big-text", "text", ARTIFACT_TEXT_LIMIT + 1);
  blob("sha-big-image", "image", ARTIFACT_BINARY_LIMIT + 1);
  blob("sha-ok-image", "image", ARTIFACT_BINARY_LIMIT);
  // Not a document: a file set keeps the general limits (a document's own file has 2 MiB).
  const artifact = await create("sizes", "index.md", "other");
  await expect(
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 0,
      publisher: { userId },
      idempotencyKey: "size-1",
      files: [file("index.md", "sha-big-text")],
    }),
  ).rejects.toMatchObject({ errorId: "artifact-file-too-large" });
  await expect(
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 0,
      publisher: { userId },
      idempotencyKey: "size-2",
      files: [file("photo.png", "sha-big-image")],
    }),
  ).rejects.toMatchObject({ errorId: "artifact-file-too-large" });
  const ok = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "size-3",
    files: [file("index.md", "sha-ok-image")],
  });
  expect(ok.status).toBe("created");
  const read = await artifacts.read({ workspaceId, reader: { userId }, artifactId: artifact.id });
  expect(read.files[0]).toMatchObject({ kind: "image", sizeBytes: ARTIFACT_BINARY_LIMIT });
});

test("the file limit counts the merged version", async () => {
  const artifact = await create("limit");
  const files = Array.from({ length: ARTIFACT_FILE_LIMIT - 1 }, (_, index) => {
    const sha256 = `sha-limit-${index}`;
    blob(sha256);
    return file(`f${index}.md`, sha256);
  });
  await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "limit-0",
    files: [...files, file("index.md", "sha-limit-0")],
    entryPath: "f0.md",
  });
  blob("sha-limit-extra");
  await expect(
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 1,
      publisher: { userId },
      idempotencyKey: "limit-1",
      files: [file("extra.md", "sha-limit-extra")],
    }),
  ).rejects.toMatchObject({ errorId: "artifact-too-many-files" });
});

test("paths are checked per segment, and deleting an absent file is refused", async () => {
  blob("sha-path");
  const artifact = await create("paths");
  for (const path of ["a//b.md", "a/../b.md", "./a.md", "a/", "a\\b.md", "/a.md"]) {
    await expect(
      artifacts.push({
        workspaceId,
        artifactId: artifact.id,
        baseVersion: 0,
        publisher: { userId },
        idempotencyKey: `path-${path}`,
        files: [file(path, "sha-path")],
      }),
    ).rejects.toMatchObject({ errorId: "artifact-file-path" });
  }
  const ok = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "path-ok",
    entryPath: "a..b.md",
    files: [file("a..b.md", "sha-path")],
  });
  expect(ok.status).toBe("created");
  await expect(
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 1,
      publisher: { userId },
      idempotencyKey: "path-missing-delete",
      deletedPaths: ["nope.md"],
    }),
  ).rejects.toMatchObject({ errorId: "artifact-file-path" });
});

test("one blob lookup serves a whole push", async () => {
  blob("sha-batch-a");
  blob("sha-batch-b");
  const artifact = await create("batch");
  inspections = 0;
  await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "batch-0",
    files: [file("index.md", "sha-batch-a"), file("b.md", "sha-batch-b")],
  });
  expect(inspections).toBe(1);
});

test("replaying a push returns the version it already made", async () => {
  blob("sha-replay");
  const artifact = await create("replay", "index.txt");
  const first = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "same-key",
    files: [file("index.txt", "sha-replay")],
  });
  const again = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "same-key",
    files: [file("index.txt", "sha-replay")],
  });
  expect(first.status).toBe("created");
  expect(again).toMatchObject({ status: "replayed", number: 1 });
});
