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
 * Files merge by path; a setting (title, description, entry file) merges item by item, as Raft's
 * do. Nothing merges inside a file: a file or a setting both sides changed to different values
 * refuses the push (`artifact-base-moved`), writing nothing.
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
let agentId: string;

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
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `am-writer-${handle}`,
        displayName: "Writer",
        ownerId: userId,
        runtimeConfig: {},
      },
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
    entryPath: "document.md",
    author: { agentId },
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
    publisher: { agentId },
    idempotencyKey: crypto.randomUUID(),
    files: files.map((sha256) => ({ path: "document.md", sha256 })),
    ...settings,
  });
}

const upload = async (text: string) =>
  (await blobs.upload({ workspaceId, bytes: new TextEncoder().encode(text), actor: { agentId } }))
    .sha256;

const current = (artifactId: string, version?: number) =>
  artifacts.read({ workspaceId, artifactId, reader: { userId }, ...(version && { version }) });

const doc = (...paragraphs: string[]) => `${paragraphs.join("\n\n")}\n`;

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
  // The version keeps what it took from others.
  expect((await current(id, 3)).version?.merged).toEqual({ files: [], settings: ["title"] });
  expect((await current(id)).artifact).toMatchObject({
    title: "Launch plan",
    description: "ready for review",
  });
  // A push that resends the base's description unchanged makes no change of its own, so the
  // others' description stays.
  await save(id, 3, undefined, { description: "ready" });
  expect(
    await save(id, 3, doc("# Plan", "more"), {
      title: "Launch plan",
      description: "ready for review",
    }),
  ).toMatchObject({ status: "created", mergedSettings: ["description"] });
  expect((await current(id)).artifact.description).toBe("ready");
  // The same new title on both sides is no conflict: it is already there, so nothing to save.
  expect(await save(id, 1, undefined, { title: "Launch plan" })).toEqual({ status: "nothing" });
});

test("two different values for one setting refuse the push, naming it, and write nothing", async () => {
  const id = await document("# Notes\n", { title: "Notes" });
  await save(id, 1, undefined, { title: "Team notes" });
  await expect(save(id, 1, "# Notes\nmore\n", { title: "My notes" })).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
    details: { settings: "title" },
  });
  expect((await current(id)).artifact).toMatchObject({ title: "Team notes", currentVersion: 2 });
});

test("both sides changing the same file refuse the push, even a Markdown line apart", async () => {
  const id = await document(doc("# Plan", "Goals: ship.", "Risks: none."));
  await save(id, 1, doc("# Plan", "Goals: ship in May.", "Risks: none."));
  // Another paragraph of the same file: no line merge, so the push is refused whole.
  await expect(
    save(id, 1, doc("# Plan", "Goals: ship.", "Risks: the date.")),
  ).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
    details: { files: "document.md" },
  });
  expect((await current(id)).artifact.currentVersion).toBe(2);
});

test("files others changed and this push does not touch are kept", async () => {
  const id = await document(doc("# Plan"));
  const notes = async (text: string, baseVersion: number) =>
    artifacts.push({
      workspaceId,
      artifactId: id,
      baseVersion,
      publisher: { agentId },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "notes.md", sha256: await upload(text) }],
    });
  await notes(doc("a", "b"), 1);
  // A push still on version 1 changes the document; the notes added since are kept.
  expect(await save(id, 1, doc("# Plan", "more"))).toMatchObject({
    status: "created",
    number: 3,
    merged: ["notes.md"],
  });
  // The same file on both sides is refused.
  await notes(doc("A", "b"), 3);
  await expect(notes(doc("a", "B"), 3)).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
    details: { files: "notes.md" },
  });
});

test("a push begun before the first version is refused on any setting that differs", async () => {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `first-${handle}`,
    entryPath: "document.md",
    author: { agentId },
    title: "Draft",
  });
  await save(artifact.id, 0, doc("# One"), { title: "Theirs" });
  await expect(save(artifact.id, 0, undefined, { title: "Mine" })).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
    details: { settings: "title" },
  });
});

test("a push whose other file conflicts writes nothing, though its document does not clash", async () => {
  const id = await document(doc("# Plan", "a", "b"));
  const both = async (text: string, notes: string, baseVersion: number) =>
    artifacts.push({
      workspaceId,
      artifactId: id,
      baseVersion,
      publisher: { agentId },
      idempotencyKey: crypto.randomUUID(),
      files: [
        { path: "document.md", sha256: await upload(text) },
        { path: "notes.md", sha256: await upload(notes) },
      ],
    });
  await both(doc("# Plan", "a", "b"), "notes\n", 1);
  await expect(both(doc("# Plan", "a", "B"), "my notes\n", 1)).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
  });
  expect((await current(id)).artifact.currentVersion).toBe(2);
});
