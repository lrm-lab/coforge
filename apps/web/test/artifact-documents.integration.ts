import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import {
  artifactDocumentsWorld,
  type ArtifactDocumentsWorld,
} from "./helpers/artifact-documents-world";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let world: ArtifactDocumentsWorld;
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
  world = await artifactDocumentsWorld(db, handle);
  ({ blobs, documents, artifacts, workspaceId, alice, bob, writer, helper, channelId, secretId } =
    world);
});

afterAll(async () => {
  await world.cleanup();
  await db.$disconnect();
});

const reading = (userId: string) => ({ workspaceId, actor: { userId } });
const writing = (agentId: string) => ({ workspaceId, actor: { agentId } });

const manifest: ArtifactDocumentsWorld["manifest"] = (...input) => world.manifest(...input);

test("a new artifact holds its files as version 1, named from its title, with a preview", async () => {
  const first = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Launch plan",
    manifest: await manifest(writer, {
      "plan.md": "# Launch plan\n\nShip in May.\n\nRisks: none.\n",
    }),
  });
  expect(first).toMatchObject({ name: "launch-plan", title: "Launch plan", currentVersion: 1 });
  expect(first.preview).toBe("# Launch plan\n\nShip in May.\n\nRisks: none.");
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
  expect(loaded.artifact.homeKind).toBe("channel");
  expect(loaded.canDelete).toBe(false);
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
  const bare = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Bare page",
    manifest: await manifest(writer, { "index.html": "<p>hi</p>" }),
  });
  expect(bare.preview).toBe("");
  const data = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Data",
    manifest: await manifest(writer, { "data.csv": "a,b\n" }),
  });
  expect(data.entryPath).toBe("data.csv");
  expect(data.preview).toBe("");
});

test("the viewer reads a body only for a document's entry; an Agent's read gets the entry's text", async () => {
  const page = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Viewer page",
    manifest: await manifest(writer, { "index.html": "<h1>Page</h1>" }),
  });
  const viewed = await documents.load(reading(bob), { artifactId: page.id }, { body: "markdown" });
  expect(viewed.text).toBe("");
  expect((await documents.load(writing(writer), { artifactId: page.id })).text).toBe(
    "<h1>Page</h1>",
  );
  expect(viewed).not.toHaveProperty("homeKind");
  expect(viewed.artifact.homeKind).toBe("channel");
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
  await expect(push(helper, 2, "A\n\nZ\n")).rejects.toMatchObject({
    code: "CONFLICT",
    errorId: "artifact-base-moved",
  });
  const [card] = await documents.cards(reading(bob), [doc.id]);
  expect(card).toMatchObject({ id: doc.id, title: "Notes", preview: "A\n\nB", currentVersion: 3 });
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
  const replay = await make("# Idem\n\nOne.\n", key);
  expect(replay.id).toBe(first.id);
  expect(replay.currentVersion).toBe(first.currentVersion);
  const loaded = await documents.load(reading(alice), { artifactId: first.id });
  expect(loaded.artifact.currentVersion).toBe(1);
  expect(loaded.text).toBe("# Idem\n\nOne.\n");
  await expect(make("# Idem\n\nTwo.\n", key)).rejects.toMatchObject({
    errorId: "artifact-idempotency-mismatch",
  });
  const other = await make("# Idem\n\nOne.\n", crypto.randomUUID());
  expect(other.id).not.toBe(first.id);
});

test("a list by home shows only the home's documents; cards read for those who can see them", async () => {
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
  const missing = crypto.randomUUID();
  const bobCards = await documents.cards(reading(bob), [open.id, closed.id, missing]);
  expect(bobCards.map((card) => card.id)).toEqual([open.id]);
  const aliceCards = await documents.cards(reading(alice), [open.id, closed.id, missing]);
  expect(aliceCards.map((card) => card.id)).toEqual([open.id, closed.id]);
});

test("a push may name only bytes its publisher uploaded or the artifact already uses", async () => {
  const doc = await documents.create(writing(writer), {
    conversationId: channelId,
    title: "Private",
    manifest: await manifest(writer, { "private.md": "mine\n" }),
  });
  const hidden = await documents.create(writing(writer), {
    conversationId: secretId,
    title: "Hidden",
    manifest: await manifest(writer, { "hidden.md": "secret plan\n" }),
  });
  const loaded = await documents.load(reading(alice), { artifactId: hidden.id });
  const sha256 = loaded.files[0]!.sha256;
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

test("a push by an Agent that cannot see the artifact is answered as if it were not there", async () => {
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

test("a create whose bytes are missing writes no artifact row: the row and version 1 are one transaction", async () => {
  const before = await db.artifact.count({ where: { workspaceId } });
  await expect(
    documents.create(writing(writer), {
      conversationId: channelId,
      title: "Lost",
      manifest: { files: [{ path: "lost.md", sha256: "f".repeat(64) }] },
    }),
  ).rejects.toMatchObject({ code: "TEMPORARILY_UNAVAILABLE", errorId: "artifact-bytes-missing" });
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

test("a push refreshes the preview only when what it draws changed, and its tail runs beside the Agent's bookkeeping", async () => {
  let reads = 0;
  const counting = new ArtifactDocuments(db, artifacts, {
    read: async (workspaceId, sha256) => {
      reads++;
      return blobs.read(workspaceId, sha256);
    },
    inspectMany: blobs.inspectMany.bind(blobs),
    allowed: blobs.allowed.bind(blobs),
  });
  const doc = await counting.create(writing(writer), {
    conversationId: channelId,
    title: "Tail work",
    manifest: await manifest(writer, { "tail.md": "# Tail\n\nBody text.\n" }),
  });
  const seen: number[] = [];
  const afterSave = async ({ number }: { number: number }) => {
    seen.push(number);
  };

  reads = 0;
  const sidecar = await manifest(writer, { "tail-notes.txt": "notes" });
  const first = await counting.push(
    writing(writer),
    {
      artifactId: doc.id,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      manifest: sidecar,
    },
    { afterSave },
  );
  expect(first.status).toBe("created");
  expect(seen).toEqual([2]);
  expect(reads).toBe(0);

  reads = 0;
  const entry = await manifest(writer, { "tail.md": "# Tail\n\nNew body.\n" });
  const key = crypto.randomUUID();
  const changed = await counting.push(
    writing(writer),
    { artifactId: doc.id, baseVersion: 2, idempotencyKey: key, manifest: entry },
    { afterSave },
  );
  expect(changed.status).toBe("created");
  expect(reads).toBe(1);
  expect(seen).toEqual([2, 3]);
  const card = (await documents.list(reading(bob), { conversationId: channelId })).find(
    (c) => c.id === doc.id,
  );
  expect(card?.preview).toContain("New body");

  const replay = await counting.push(
    writing(writer),
    { artifactId: doc.id, baseVersion: 2, idempotencyKey: key, manifest: entry },
    { afterSave },
  );
  expect(replay.status).toBe("replayed");
  expect(seen).toEqual([2, 3, 3]);
  expect(reads).toBe(1);
});
