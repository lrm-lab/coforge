import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

/**
 * Saving over an older version (task #385): what others changed since the save's base is kept.
 * A setting (title, description, entry file) merges item by item, as Raft's do; two different
 * values for the same item are a conflict the save answers with both, writing nothing.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let blobs: StoredArtifactBlobs;
let artifacts: Artifacts;
let workspaceId: string;
let userId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-merge-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  userId = (await db.user.create({ data: { username: `am-${handle}`, displayName: "Merge" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: { slug: `am-${handle}`, name: "Merge", members: { create: { userId, role: "owner" } } },
    })
  ).id;
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.delete({ where: { id: userId } }).catch(() => undefined);
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

let made = 0;
async function document(text: string, settings: { title?: string; description?: string } = {}) {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `doc-${(made += 1)}-${handle}`,
    kind: "markdown",
    entryPath: "document.md",
    author: { userId },
    ...settings,
  });
  await save(artifact.id, 0, text);
  return artifact.id;
}

async function save(
  artifactId: string,
  baseVersion: number,
  text?: string,
  settings: { title?: string; description?: string } = {},
) {
  const files = text === undefined ? [] : [await upload(text)];
  return artifacts.push({
    workspaceId,
    artifactId,
    baseVersion,
    publisher: { userId },
    idempotencyKey: crypto.randomUUID(),
    files: files.map((sha256) => ({ path: "document.md", sha256 })),
    ...settings,
  });
}

const upload = async (text: string) =>
  (await blobs.upload({ workspaceId, bytes: new TextEncoder().encode(text) })).sha256;

const current = (artifactId: string, version?: number) =>
  artifacts.read({ workspaceId, artifactId, reader: { userId }, ...(version && { version }) });

test("a version keeps the title and description it was saved with", async () => {
  const id = await document("# One\n", { title: "First", description: "the first" });
  await save(id, 1, undefined, { title: "Second" });
  expect((await current(id, 1)).version).toMatchObject({
    title: "First",
    description: "the first",
  });
  expect((await current(id, 2)).version).toMatchObject({
    title: "Second",
    description: "the first",
  });
  expect((await current(id)).artifact.title).toBe("Second");
});

test("settings merge item by item: each side's change to a different item is kept", async () => {
  const id = await document("# Plan\n", { title: "Plan", description: "draft" });
  // Someone retitles it (version 2) while this save, still on version 1, changes the description.
  await save(id, 1, undefined, { title: "Launch plan" });
  const merged = await save(id, 1, undefined, { description: "ready for review" });
  expect(merged).toMatchObject({ status: "created", number: 3, mergedSettings: ["title"] });
  expect((await current(id)).artifact).toMatchObject({
    title: "Launch plan",
    description: "ready for review",
  });
  // The same new title on both sides is no conflict: it is already there, so nothing to save.
  expect(await save(id, 1, undefined, { title: "Launch plan" })).toEqual({ status: "nothing" });
});

test("two different values for one setting are a conflict that names both and writes nothing", async () => {
  const id = await document("# Notes\n", { title: "Notes" });
  await save(id, 1, undefined, { title: "Team notes" });
  const conflict = await save(id, 1, "# Notes\nmore\n", { title: "My notes" });
  expect(conflict).toEqual({
    status: "conflict",
    currentVersion: 2,
    files: [],
    settings: [{ name: "title", base: "Notes", mine: "My notes", theirs: "Team notes" }],
  });
  expect((await current(id)).artifact).toMatchObject({ title: "Team notes", currentVersion: 2 });
});
