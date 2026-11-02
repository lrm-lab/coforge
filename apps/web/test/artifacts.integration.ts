import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts, type ArtifactBlobStore } from "#src/server/artifacts/artifacts.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let userId: string;

const blobs = new Set<string>();
const store: ArtifactBlobStore = { has: async (_workspaceId, sha256) => blobs.has(sha256) };
const artifacts = new Artifacts(db, store);

const file = (path: string, sha256: string) => ({
  path,
  sha256,
  sizeBytes: 10,
  kind: "text" as const,
});

beforeAll(async () => {
  const user = await db.user.create({
    data: { username: `artifact-${handle}`, displayName: "Artifact User" },
  });
  userId = user.id;
  const workspace = await db.workspace.create({
    data: { slug: `artifacts-${handle}`, name: "Artifacts" },
  });
  workspaceId = workspace.id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
});

test("an artifact gets a unique name within its home", async () => {
  const input = {
    workspaceId,
    home: { kind: "workspace" as const },
    name: `page-${handle}`,
    kind: "markdown",
    entryPath: "index.md",
    author: { userId },
  };
  const created = await artifacts.create(input);
  expect(created.name).toBe(input.name);
  await expect(artifacts.create(input)).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a push inherits unlisted files and records what changed", async () => {
  blobs.add("sha-a");
  blobs.add("sha-b");
  blobs.add("sha-c");
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `push-${handle}`,
    kind: "markdown",
    entryPath: "index.md",
    author: { userId },
  });
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

  const read = await artifacts.read({ workspaceId, artifactId: artifact.id });
  expect(read.version?.number).toBe(2);
  expect(read.files.map((entry) => entry.path)).toEqual(["index.md"]);
  expect(read.files[0]!.sha256).toBe("sha-c");

  const old = await artifacts.read({ workspaceId, artifactId: artifact.id, version: 1 });
  expect(old.files.map((entry) => entry.path)).toEqual(["index.md", "notes.txt"]);
});

test("a missing blob and a moved base are refused", async () => {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `refuse-${handle}`,
    kind: "markdown",
    entryPath: "index.md",
    author: { userId },
  });
  const missing = await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "missing-1",
    files: [file("index.md", "sha-absent")],
  });
  expect(missing).toEqual({ status: "missing", missing: ["sha-absent"] });

  blobs.add("sha-base");
  await artifacts.push({
    workspaceId,
    artifactId: artifact.id,
    baseVersion: 0,
    publisher: { userId },
    idempotencyKey: "base-1",
    files: [file("index.md", "sha-base")],
  });
  await expect(
    artifacts.push({
      workspaceId,
      artifactId: artifact.id,
      baseVersion: 0,
      publisher: { userId },
      idempotencyKey: "base-2",
      files: [file("index.md", "sha-base")],
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("replaying a push returns the version it already made", async () => {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `replay-${handle}`,
    kind: "text",
    entryPath: "index.txt",
    author: { userId },
  });
  blobs.add("sha-replay");
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
