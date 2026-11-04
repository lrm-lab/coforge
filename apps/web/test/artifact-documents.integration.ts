import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";

/**
 * Documents as the web page uses them (task #385, step 5): the page sends and receives the
 * document's text, never blobs, and lists and shows cards of the documents a reader may read.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let blobs: StoredArtifactBlobs;
let documents: ArtifactDocuments;
let artifacts: Artifacts;
let workspaceId: string;
let alice: string;
let bob: string;
let channelId: string;
let secretId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-documents-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  alice = (await db.user.create({ data: { username: `ad-a-${handle}`, displayName: "Alice" } })).id;
  bob = (await db.user.create({ data: { username: `ad-b-${handle}`, displayName: "Bob" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `ad-${handle}`,
        name: "Docs",
        members: {
          create: [
            { userId: alice, role: "owner" },
            { userId: bob, role: "member" },
          ],
        },
      },
    })
  ).id;
  const channel = async (name: string, visibility: string, members: string[]) => {
    const { id } = await db.conversation.create({
      data: { workspaceId, channelName: `${name}-${handle}`, visibility },
    });
    await db.conversationMember.createMany({
      data: members.map((userId) => ({ conversationId: id, workspaceId, userId })),
    });
    return id;
  };
  channelId = await channel("launch", "public", [alice, bob]);
  secretId = await channel("secret", "private", [alice]);
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const scope = (userId: string) => ({ workspaceId, actor: { userId } });

test("a new document holds its text as version 1, named from its title, with a preview", async () => {
  const first = await documents.create(scope(alice), {
    conversationId: channelId,
    title: "Launch plan",
    text: "# Launch plan\n\nShip in May.\n\nRisks: none.\n",
  });
  expect(first).toMatchObject({ name: "launch-plan", title: "Launch plan", currentVersion: 1 });
  expect(first.preview).toBe("Launch plan\nShip in May.");
  // The same title again gets a free name of its own.
  const second = await documents.create(scope(alice), {
    conversationId: channelId,
    title: "Launch plan",
  });
  expect(second.name).toBe("launch-plan-2");
  expect(second.currentVersion).toBe(0);

  const loaded = await documents.load(scope(bob), { artifactId: first.id });
  expect(loaded.text).toBe("# Launch plan\n\nShip in May.\n\nRisks: none.\n");
  expect(loaded.artifact.homeKey).toBe(`conversation:${channelId}`);
  // A channel document; its kind comes from the home access the read already made (no new query).
  expect(loaded.homeKind).toBe("channel");
  // Bob reads it but did not write it and is not an owner/admin: he cannot delete it.
  expect(loaded.canDelete).toBe(false);
  // Alice wrote it (and owns the Workspace), so she can.
  expect((await documents.load(scope(alice), { artifactId: first.id })).canDelete).toBe(true);
});

test("saving sends text: a new version, its preview, and the merge answers as for any save", async () => {
  const doc = await documents.create(scope(alice), {
    conversationId: channelId,
    title: "Notes",
    text: "a\n\nb\n",
  });
  const save = (userId: string, baseVersion: number, text: string) =>
    documents.save(scope(userId), {
      artifactId: doc.id,
      baseVersion,
      text,
      idempotencyKey: crypto.randomUUID(),
    });
  expect(await save(bob, 1, "A\n\nb\n")).toMatchObject({ status: "created", number: 2 });
  expect(await save(alice, 1, "a\n\nB\n")).toMatchObject({ status: "created", number: 3 });
  expect((await documents.load(scope(alice), { artifactId: doc.id })).text).toBe("A\n\nB\n");
  expect((await documents.load(scope(alice), { artifactId: doc.id, version: 2 })).text).toBe(
    "A\n\nb\n",
  );
  expect((await save(alice, 3, "A\n\nB\n")).status).toBe("nothing");
  // Both changed the second paragraph since version 2.
  expect(await save(bob, 2, "A\n\nZ\n")).toMatchObject({ status: "conflict", currentVersion: 3 });
  const [card] = await documents.cards(scope(bob), [doc.id]);
  expect(card).toMatchObject({ id: doc.id, title: "Notes", preview: "A\nB", currentVersion: 3 });
});

test("a list and cards show only documents the reader can read", async () => {
  const open = await documents.create(scope(alice), { conversationId: channelId, title: "Open" });
  const closed = await documents.create(scope(alice), {
    conversationId: secretId,
    title: "Closed",
  });
  const listed = await documents.list(scope(bob), { conversationId: channelId });
  expect(listed.map((doc) => doc.id)).toContain(open.id);
  await expect(documents.list(scope(bob), { conversationId: secretId })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const cards = await documents.cards(scope(bob), [open.id, closed.id, crypto.randomUUID()]);
  expect(cards.map((card) => card.id)).toEqual([open.id]);
});

test("a save may name only bytes its publisher uploaded or the document already uses", async () => {
  const doc = await documents.create(scope(alice), { conversationId: channelId, title: "Private" });
  // Bytes alice stored for a document bob cannot read.
  const hidden = await documents.create(scope(alice), {
    conversationId: secretId,
    title: "Hidden",
    text: "secret plan\n",
  });
  const loaded = await documents.load(scope(alice), { artifactId: hidden.id });
  const sha256 = loaded.files[0]!.sha256;
  // Bob learned the hash somehow: naming it is answered as if the bytes were not there.
  expect(
    await artifacts.push({
      workspaceId,
      artifactId: doc.id,
      baseVersion: 0,
      publisher: { userId: bob },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "document.md", sha256 }],
    }),
  ).toEqual({ status: "missing", missing: [sha256] });
  // Uploading those bytes himself grants them to him.
  await blobs.upload({
    workspaceId,
    bytes: new TextEncoder().encode("secret plan\n"),
    actor: { userId: bob },
  });
  expect(
    await artifacts.push({
      workspaceId,
      artifactId: doc.id,
      baseVersion: 0,
      publisher: { userId: bob },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "document.md", sha256 }],
    }),
  ).toMatchObject({ status: "created" });
});

test("a save by someone who may not write stores nothing, and text that is not text is refused", async () => {
  const closed = await documents.create(scope(alice), { conversationId: secretId, title: "Kept" });
  const unique = `bob tried ${crypto.randomUUID()}\n`;
  const sha256 = new Bun.CryptoHasher("sha256").update(unique).digest("hex");
  await expect(
    documents.save(scope(bob), {
      artifactId: closed.id,
      baseVersion: 0,
      text: unique,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256 } })).toBe(0);
  await expect(
    documents.save(scope(alice), {
      artifactId: closed.id,
      baseVersion: 0,
      text: "a\u0000b",
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-text" });
});

test("a text too large for a document is refused before the document is made", async () => {
  const before = await db.artifact.count({ where: { workspaceId } });
  await expect(
    documents.create(scope(alice), {
      conversationId: channelId,
      title: "Big",
      text: "é".repeat(1_100_000),
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-file-too-large" });
  expect(await db.artifact.count({ where: { workspaceId } })).toBe(before);
});

test("going back keeps the card's preview from the version gone back to", async () => {
  const doc = await documents.create(scope(alice), {
    conversationId: channelId,
    title: "Back",
    text: "one\n",
  });
  await documents.save(scope(alice), {
    artifactId: doc.id,
    baseVersion: 1,
    text: "two\n",
    idempotencyKey: crypto.randomUUID(),
  });
  await documents.revert({
    workspaceId,
    artifactId: doc.id,
    actor: { userId: alice },
    to: 1,
    baseVersion: 2,
    idempotencyKey: crypto.randomUUID(),
  });
  expect((await documents.cards(scope(alice), [doc.id]))[0]).toMatchObject({
    currentVersion: 3,
    preview: "one",
  });
});

test("titles that name alike, in any script, each get a name of their own", async () => {
  const names = new Set<string>();
  for (let index = 0; index < 6; index += 1)
    names.add(
      (await documents.create(scope(alice), { conversationId: channelId, title: "发布计划" })).name,
    );
  expect(names.size).toBe(6);
  expect([...names].slice(0, 3)).toEqual(["document", "document-2", "document-3"]);
});

test("a page save writes the document's own file, whatever it is named", async () => {
  const made = await artifacts.create({
    workspaceId,
    home: { kind: "conversation", conversationId: channelId },
    name: `readme-${handle}`,
    kind: "markdown",
    entryPath: "README.md",
    author: { userId: alice },
  });
  await documents.save(scope(alice), {
    artifactId: made.id,
    baseVersion: 0,
    text: "page edit\n",
    idempotencyKey: crypto.randomUUID(),
  });
  const loaded = await documents.load(scope(alice), { artifactId: made.id });
  expect(loaded.files.map((file) => file.path)).toEqual(["README.md"]);
  expect(loaded.text).toBe("page edit\n");
});

test("with documents off, a save stores nothing", async () => {
  const off = new ArtifactDocuments(
    db,
    new Artifacts(db, blobs, { enabled: async () => false }),
    blobs,
  );
  const doc = await documents.create(scope(alice), { conversationId: channelId, title: "Off" });
  const unique = `off ${crypto.randomUUID()}\n`;
  await expect(
    off.save(scope(alice), {
      artifactId: doc.id,
      baseVersion: 0,
      text: unique,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ errorId: "artifacts-disabled" });
  const sha256 = new Bun.CryptoHasher("sha256").update(unique).digest("hex");
  expect(await db.artifactBlob.count({ where: { workspaceId, sha256 } })).toBe(0);
});
