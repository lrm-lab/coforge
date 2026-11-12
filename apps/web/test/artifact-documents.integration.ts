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
 * The artifact use cases the Agent API and the web page share (task #385): an Agent creates and
 * pushes manifests of files, and the web page reads the entry file's text, lists, and shows cards
 * of the artifacts a reader may read.
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
let writer: string;
let helper: string;
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
  const newAgent = async (name: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId,
          name: `ad-${name}-${handle}`,
          displayName: name,
          ownerId: alice,
          runtimeConfig: {},
        },
      })
    ).id;
  writer = await newAgent("writer");
  helper = await newAgent("helper");
  const channel = async (
    name: string,
    visibility: string,
    members: ({ userId: string } | { agentId: string })[],
  ) => {
    const { id } = await db.conversation.create({
      data: { workspaceId, channelName: `${name}-${handle}`, visibility },
    });
    await db.conversationMember.createMany({
      data: members.map((member) => ({ conversationId: id, workspaceId, ...member })),
    });
    return id;
  };
  channelId = await channel("launch", "public", [
    { userId: alice },
    { userId: bob },
    { agentId: writer },
    { agentId: helper },
  ]);
  secretId = await channel("secret", "private", [{ userId: alice }, { agentId: writer }]);
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const reading = (userId: string) => ({ workspaceId, actor: { userId } });
const writing = (agentId: string) => ({ workspaceId, actor: { agentId } });

/** Uploads each file's text for the Agent and names it as a manifest. */
async function manifest(agentId: string, files: Record<string, string>, entryPath?: string) {
  const named = await Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      sha256: (
        await blobs.upload({
          workspaceId,
          bytes: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>,
          actor: { agentId },
        })
      ).sha256,
    })),
  );
  return { files: named, ...(entryPath ? { entryPath } : {}) };
}

test("a new artifact holds its files as version 1, named from its title, with a preview", async () => {
  const first = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Launch plan",
    manifest: await manifest(writer, {
      "plan.md": "# Launch plan\n\nShip in May.\n\nRisks: none.\n",
    }),
  });
  expect(first).toMatchObject({ name: "launch-plan", title: "Launch plan", currentVersion: 1 });
  expect(first.preview).toBe("Launch plan\nShip in May.");
  // The same title again gets a free name of its own.
  const second = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Launch plan",
    manifest: await manifest(writer, { "plan.md": "# Another\n" }),
  });
  expect(second.name).toBe("launch-plan-2");
  expect(second.currentVersion).toBe(1);

  const loaded = await documents.load(reading(bob), { artifactId: first.id });
  expect(loaded.text).toBe("# Launch plan\n\nShip in May.\n\nRisks: none.\n");
  expect(loaded.artifact).toMatchObject({
    homeKey: `conversation:${channelId}`,
    entryPath: "plan.md",
  });
  // A channel artifact; its kind comes from the home access the read already made (no new query).
  expect(loaded.homeKind).toBe("channel");
  // Bob reads it but did not write it and is not an owner/admin: he cannot delete it.
  expect(loaded.canDelete).toBe(false);
  // Alice owns the Workspace, so she can; so can the Agent that wrote it.
  expect((await documents.load(reading(alice), { artifactId: first.id })).canDelete).toBe(true);
  expect((await documents.load(writing(writer), { artifactId: first.id })).canDelete).toBe(true);
});

test("the entry file gives the type: a web page's card line is its description, and no kind is stored", async () => {
  const page = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Funnel",
    description: "Signups by day",
    manifest: await manifest(writer, { "index.html": "<h1>Funnel</h1>" }),
  });
  expect(page.preview).toBe("Signups by day");
  expect(page.entryPath).toBe("index.html");
  expect(page).not.toHaveProperty("kind");
  // A web page needs no description; its card line is then empty.
  const bare = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Bare page",
    manifest: await manifest(writer, { "index.html": "<p>hi</p>" }),
  });
  expect(bare.preview).toBe("");
  // An entry file the page cannot show is refused before anything is made.
  const before = await db.artifact.count({ where: { workspaceId } });
  await expect(
    documents.create(writing(writer), {
      conversationId: channelId,
      title: "Data",
      manifest: await manifest(writer, { "data.csv": "a,b\n" }),
    }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-entry-type" });
  expect(await db.artifact.count({ where: { workspaceId } })).toBe(before);
});

test("a push is a new version with its preview, and a clash with another Agent's push is refused", async () => {
  const doc = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Notes",
    manifest: await manifest(writer, { "notes.md": "a\n\nb\n" }),
  });
  const push = async (agentId: string, baseVersion: number, text: string) =>
    documents.push(writing(agentId), {
      artifactId: doc.id,
      baseVersion,
      manifest: await manifest(agentId, { "notes.md": text }),
      idempotencyKey: crypto.randomUUID(),
    });
  expect(await push(helper, 1, "A\n\nb\n")).toMatchObject({ status: "created", number: 2 });
  expect(await push(writer, 2, "A\n\nB\n")).toMatchObject({ status: "created", number: 3 });
  expect((await documents.load(reading(alice), { artifactId: doc.id })).text).toBe("A\n\nB\n");
  expect((await documents.load(reading(alice), { artifactId: doc.id, version: 2 })).text).toBe(
    "A\n\nb\n",
  );
  expect((await push(writer, 3, "A\n\nB\n")).status).toBe("nothing");
  // The same file changed on both sides since version 2: refused, nothing merged inside it.
  await expect(push(helper, 2, "A\n\nZ\n")).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
  });
  const [card] = await documents.cards(reading(bob), [doc.id]);
  expect(card).toMatchObject({ id: doc.id, title: "Notes", preview: "A\nB", currentVersion: 3 });
});

test("an idempotent create replays the same artifact, and a different input with one key conflicts", async () => {
  const key = crypto.randomUUID();
  const make = async (text: string, idempotencyKey: string) =>
    documents.create(writing(writer), {
      conversationId: channelId,
      title: "Idem plan",
      manifest: await manifest(writer, { "idem.md": text }),
      idempotencyKey,
    });
  const first = await make("# Idem\n\nOne.\n", key);
  // The same key with the same inputs returns the same artifact, and adds no second version.
  const replay = await make("# Idem\n\nOne.\n", key);
  expect(replay.id).toBe(first.id);
  expect(replay.currentVersion).toBe(first.currentVersion);
  const loaded = await documents.load(reading(alice), { artifactId: first.id });
  expect(loaded.artifact.currentVersion).toBe(1);
  expect(loaded.text).toBe("# Idem\n\nOne.\n");
  // The same key with different files (or title, or home) is a mistake, not a retry.
  await expect(make("# Idem\n\nTwo.\n", key)).rejects.toMatchObject({
    errorId: "artifact-idempotency-mismatch",
  });
  // A fresh key makes a second artifact.
  const other = await make("# Idem\n\nOne.\n", crypto.randomUUID());
  expect(other.id).not.toBe(first.id);
});

test("a list and cards show only artifacts the reader can read", async () => {
  const open = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Open",
    manifest: await manifest(writer, { "open.md": "open\n" }),
  });
  const closed = await documents.create(writing(writer), {
    conversationId: secretId,
    title: "Closed",
    manifest: await manifest(writer, { "closed.md": "closed\n" }),
  });
  const listed = await documents.list(reading(bob), { conversationId: channelId });
  expect(listed.map((doc) => doc.id)).toContain(open.id);
  await expect(documents.list(reading(bob), { conversationId: secretId })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const cards = await documents.cards(reading(bob), [open.id, closed.id, crypto.randomUUID()]);
  expect(cards.map((card) => card.id)).toEqual([open.id]);
});

test("a push may name only bytes its publisher uploaded or the artifact already uses", async () => {
  const doc = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Private",
    manifest: await manifest(writer, { "private.md": "mine\n" }),
  });
  // Bytes the writer stored for an artifact the helper cannot read.
  const hidden = await documents.create(writing(writer), {
    conversationId: secretId,
    title: "Hidden",
    manifest: await manifest(writer, { "hidden.md": "secret plan\n" }),
  });
  const loaded = await documents.load(reading(alice), { artifactId: hidden.id });
  const sha256 = loaded.files[0]!.sha256;
  // The helper learned the hash somehow: naming it is answered as if the bytes were not there.
  expect(
    await artifacts.push({
      workspaceId,
      artifactId: doc.id,
      baseVersion: 1,
      publisher: { agentId: helper },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "stolen.md", sha256 }],
    }),
  ).toEqual({ status: "missing", missing: [sha256] });
  // Uploading those bytes itself grants them to it.
  await blobs.upload({
    workspaceId,
    bytes: new TextEncoder().encode("secret plan\n"),
    actor: { agentId: helper },
  });
  expect(
    await artifacts.push({
      workspaceId,
      artifactId: doc.id,
      baseVersion: 1,
      publisher: { agentId: helper },
      idempotencyKey: crypto.randomUUID(),
      files: [{ path: "stolen.md", sha256 }],
    }),
  ).toMatchObject({ status: "created" });
});

test("a push by an Agent that may not write there is answered as if the artifact were not there", async () => {
  const closed = await documents.create(writing(writer), {
    conversationId: secretId,
    title: "Kept",
    manifest: await manifest(writer, { "kept.md": "kept\n" }),
  });
  await expect(
    documents.push(writing(helper), {
      artifactId: closed.id,
      baseVersion: 1,
      title: "Taken over",
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await documents.load(reading(alice), { artifactId: closed.id })).artifact.title).toBe(
    "Kept",
  );
});

test("titles that name alike, in any script, each get a name of their own", async () => {
  const names = new Set<string>();
  for (let index = 0; index < 6; index += 1)
    names.add(
      (
        await documents.create(writing(writer), {
          conversationId: channelId,
          title: "发布计划",
          manifest: await manifest(writer, { "plan.md": `# ${index}\n` }),
        })
      ).name,
    );
  expect(names.size).toBe(6);
  expect([...names].slice(0, 3)).toEqual(["artifact", "artifact-2", "artifact-3"]);
});

test("a manifest that names bytes the Agent never uploaded is asked for before anything is made", async () => {
  const before = await db.artifact.count({ where: { workspaceId } });
  const sha256 = "e".repeat(64);
  expect(
    await documents.missingBytes(writing(writer), {
      manifest: { files: [{ path: "x.md", sha256 }] },
    }),
  ).toEqual([sha256]);
  expect(await db.artifact.count({ where: { workspaceId } })).toBe(before);
});

test("with artifacts off, a push stores nothing", async () => {
  const off = new ArtifactDocuments(
    db,
    new Artifacts(db, blobs, { enabled: async () => false }),
    blobs,
  );
  const doc = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Off",
    manifest: await manifest(writer, { "off.md": "off\n" }),
  });
  await expect(
    off.push(writing(writer), {
      artifactId: doc.id,
      baseVersion: 1,
      title: "Changed",
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ errorId: "artifacts-disabled" });
});
