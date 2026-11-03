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
  (await blobs.upload({ workspaceId, bytes: new TextEncoder().encode(text), actor: { userId } }))
    .sha256;

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
  // The version keeps it, for the history.
  expect((await current(id, 3)).version?.merged).toEqual({ files: [], settings: ["title"] });
  expect((await current(id)).artifact).toMatchObject({
    title: "Launch plan",
    description: "ready for review",
  });
  // A form that sends every field resends the base's description unchanged: that is no change of
  // its own, so the others' description stays.
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

/** The document's text at a version. */
async function textOf(artifactId: string, version?: number) {
  const { files } = await current(artifactId, version);
  const opened = await blobs.open(workspaceId, files[0]!.sha256);
  return new Response(opened!.body).text();
}

const doc = (...paragraphs: string[]) => `${paragraphs.join("\n\n")}\n`;

test("two saves that changed different paragraphs merge line by line into one version", async () => {
  const id = await document(doc("# Plan", "Goals: ship.", "Risks: none."));
  // An Agent saves version 2 while a person, still on version 1, edits another paragraph.
  await save(id, 1, doc("# Plan", "Goals: ship in May.", "Risks: none."));
  const merged = await save(id, 1, doc("# Plan", "Goals: ship.", "Risks: the date."));
  expect(merged).toMatchObject({ status: "created", number: 3, merged: ["document.md"] });
  expect(await textOf(id)).toBe(doc("# Plan", "Goals: ship in May.", "Risks: the date."));
});

test("both sides changing the same paragraph is a conflict that shows both and writes nothing", async () => {
  const id = await document(doc("# Plan", "Goals: ship.", "Risks: none."));
  await save(id, 1, doc("# Plan", "Goals: ship in May.", "Risks: none."));
  const conflict = await save(id, 1, doc("# Plan", "Goals: ship in June.", "Risks: none."));
  expect(conflict).toEqual({
    status: "conflict",
    currentVersion: 2,
    settings: [],
    files: [
      {
        path: "document.md",
        chunks: [
          { ok: "# Plan\n\n" },
          {
            conflict: {
              base: "Goals: ship.\n",
              mine: "Goals: ship in June.\n",
              theirs: "Goals: ship in May.\n",
            },
          },
          { ok: "\nRisks: none.\n" },
        ],
      },
    ],
  });
  expect((await current(id)).artifact.currentVersion).toBe(2);
});

test("one side deleting a paragraph the other changed is a conflict too", async () => {
  const id = await document(doc("# Plan", "Goals: ship.", "Risks: none."));
  await save(id, 1, doc("# Plan", "Risks: none."));
  const conflict = await save(id, 1, doc("# Plan", "Goals: ship soon.", "Risks: none."));
  expect(conflict).toMatchObject({ status: "conflict", currentVersion: 2 });
  if (conflict.status !== "conflict") throw new Error("expected a conflict");
  const chunk = conflict.files[0]!.chunks.find((piece) => "conflict" in piece);
  expect(chunk).toMatchObject({ conflict: { mine: expect.stringContaining("Goals: ship soon.") } });
  expect(chunk).toMatchObject({ conflict: { theirs: expect.not.stringContaining("Goals") } });
});

test("resolving a conflict is saving the chosen text over the version it showed", async () => {
  const id = await document(doc("# Plan", "Goals: ship."));
  await save(id, 1, doc("# Plan", "Goals: ship in May."));
  const conflict = await save(id, 1, doc("# Plan", "Goals: ship in June."));
  if (conflict.status !== "conflict") throw new Error("expected a conflict");
  expect(
    await save(id, conflict.currentVersion, doc("# Plan", "Goals: ship in June.")),
  ).toMatchObject({ status: "created", number: 3 });
  expect(await textOf(id)).toBe(doc("# Plan", "Goals: ship in June."));
});

test("only the document itself merges by line; another file both sides changed is refused", async () => {
  const id = await document(doc("# Plan"));
  const notes = async (text: string, baseVersion: number) =>
    artifacts.push({
      workspaceId,
      artifactId: id,
      baseVersion,
      publisher: { userId },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "notes.md", sha256: await upload(text) }],
    });
  await notes(doc("a", "b"), 1);
  await notes(doc("A", "b"), 2);
  await expect(notes(doc("a", "B"), 2)).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
  });
});

test("a document over 2 MiB is refused before anything merges it", async () => {
  const id = await document(doc("# Plan", "a"));
  await save(id, 1, doc("# Plan", "A"));
  await expect(
    save(id, 1, `${doc("# Plan", "a")}${"x".repeat(2 * 1024 * 1024)}`),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-file-too-large" });
});

test("a save begun before the first version conflicts on any setting that differs, with no base", async () => {
  const artifact = await artifacts.create({
    workspaceId,
    home: { kind: "workspace" },
    name: `first-${handle}`,
    kind: "markdown",
    entryPath: "document.md",
    author: { userId },
    title: "Draft",
  });
  await save(artifact.id, 0, doc("# One"), { title: "Theirs" });
  expect(await save(artifact.id, 0, undefined, { title: "Mine" })).toEqual({
    status: "conflict",
    currentVersion: 1,
    files: [],
    settings: [{ name: "title", base: null, mine: "Mine", theirs: "Theirs" }],
  });
});

test("a save whose document merges but whose other file conflicts writes nothing", async () => {
  const id = await document(doc("# Plan", "a", "b"));
  const both = async (text: string, notes: string, baseVersion: number) =>
    artifacts.push({
      workspaceId,
      artifactId: id,
      baseVersion,
      publisher: { userId },
      idempotencyKey: crypto.randomUUID(),
      files: [
        { path: "document.md", sha256: await upload(text) },
        { path: "notes.md", sha256: await upload(notes) },
      ],
    });
  await both(doc("# Plan", "a", "b"), "notes\n", 1);
  await both(doc("# Plan", "A", "b"), "notes v3\n", 2);
  await expect(both(doc("# Plan", "a", "B"), "my notes\n", 2)).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
  });
  expect((await current(id)).artifact.currentVersion).toBe(3);
});
