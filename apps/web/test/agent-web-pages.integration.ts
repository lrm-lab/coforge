import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { ArtifactSandbox } from "#src/server/artifacts/artifact-sandbox.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * Web pages (task #490): an Agent makes one with `create --kind html` and a description, reads
 * its source, and saves it whole; a save over a version someone else moved past is refused, never
 * merged. A person reads it and goes back to a version, but cannot make or save one. What an Agent
 * saved is what the sandbox origin serves.
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
let agentId: string;
let channelId: string;
let webPages = true;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-web-pages-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  alice = (await db.user.create({ data: { username: `wp-a-${handle}`, displayName: "Alice" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `wp-${handle}`,
        name: "Pages",
        members: { create: [{ userId: alice, role: "owner" }] },
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `wp-bot-${handle}`,
        displayName: "Bot",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  channelId = (
    await db.conversation.create({
      data: { workspaceId, channelName: `growth-${handle}`, visibility: "public" },
    })
  ).id;
  await db.conversationMember.createMany({
    data: [
      { conversationId: channelId, workspaceId, userId: alice },
      { conversationId: channelId, workspaceId, agentId },
    ],
  });
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: alice } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

async function post(body: unknown) {
  const response = await handleAgentArtifactPost(
    new Request("http://local/api/agent/v1/artifacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { workspaceId, agentId },
    { db, artifacts, documents, enabled: async () => true, webPages: async () => webPages },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const key = () => crypto.randomUUID();
const PAGE_1 = "<!doctype html><h1>Signups</h1><script>document.title = 'v1'</script>";
const PAGE_2 = "<!doctype html><h1>Signups and activation</h1>";

test("an Agent makes a web page, reads its source, and saves it whole", async () => {
  const created = await post({
    operation: "create",
    kind: "html",
    title: "Signup funnel",
    description: "Signups by day, with a toggle per channel",
    target: `#growth-${handle}`,
    text: PAGE_1,
    idempotencyKey: key(),
  });
  expect(created).toMatchObject({
    status: 200,
    body: { name: "signup-funnel", kind: "html", currentVersion: 1 },
  });
  const artifact = created.body.id as string;
  const read = await post({ operation: "read", artifact });
  expect(read.body).toMatchObject({
    text: PAGE_1,
    artifact: {
      kind: "html",
      entryPath: "index.html",
      description: "Signups by day, with a toggle per channel",
    },
  });

  // Its card line is its description, not its source.
  expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact } })).preview).toBe(
    "Signups by day, with a toggle per channel",
  );

  const saved = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    text: PAGE_2,
  });
  expect(saved.body).toMatchObject({ status: "created", number: 2 });

  // Over version 1 again: someone saved since, and a page is never merged. Nothing is written.
  const stale = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    text: "<!doctype html><h1>Mine</h1>",
  });
  expect(stale).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
  expect(stale.body.error).toContain("artifact-base-moved");
  expect((await post({ operation: "read", artifact })).body.text).toBe(PAGE_2);

  // Even when only the description moved since: a page's save starts from the newest version.
  const described = await post({
    operation: "push",
    artifact,
    baseVersion: 2,
    idempotencyKey: key(),
    description: "Signups and activation by day",
  });
  expect(described.body).toMatchObject({ status: "created", number: 3 });
  expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact } })).preview).toBe(
    "Signups and activation by day",
  );
  const overSettings = await post({
    operation: "push",
    artifact,
    baseVersion: 2,
    idempotencyKey: key(),
    text: "<!doctype html><h1>Mine</h1>",
  });
  expect(overSettings).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
  expect(overSettings.body.error).toContain("artifact-base-moved");

  // The sandbox serves exactly what was saved.
  const sandbox = new ArtifactSandbox({
    reads: artifacts.reads,
    readBlob: (w, sha256) => blobs.read(w, sha256),
    origin: "http://127.0.0.1:5199",
    secret: async () => "x".repeat(40),
    now: () => new Date(),
  });
  const link = await sandbox.link({
    workspaceId,
    userId: alice,
    artifactId: artifact,
    embedderOrigin: "http://localhost:5173",
  });
  const page = await sandbox.serve(
    new Request(`${link.url}/page`, {
      headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
    }),
  );
  expect(await page.text()).toEndWith(PAGE_2.slice("<!doctype html>".length));
});

test("a person reads a web page and goes back to a version, but cannot make or save one", async () => {
  const me = { workspaceId, actor: { userId: alice } };
  const { body } = await post({
    operation: "create",
    kind: "html",
    title: "Options",
    description: "Three layouts side by side",
    target: `#growth-${handle}`,
    text: PAGE_1,
  });
  const artifact = body.id as string;
  await post({ operation: "push", artifact, baseVersion: 1, idempotencyKey: key(), text: PAGE_2 });

  expect((await documents.load(me, { artifactId: artifact })).text).toBe(PAGE_2);
  for (const save of [{ text: "<p>mine</p>" }, { title: "Renamed" }, { label: "final" }])
    await expect(
      documents.save(me, { artifactId: artifact, baseVersion: 2, idempotencyKey: key(), ...save }),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED", errorId: "artifact-page-agent-only" });
  await expect(
    documents.create(me, {
      conversationId: channelId,
      kind: "html",
      title: "Mine",
      description: "x",
      text: PAGE_1,
    }),
  ).rejects.toMatchObject({ errorId: "artifact-page-agent-only" });

  // Going back is a person's to do.
  const reverted = await documents.revert({
    ...me,
    artifactId: artifact,
    to: 1,
    baseVersion: 2,
    idempotencyKey: key(),
  });
  expect(reverted).toMatchObject({ status: "created", number: 3 });
  expect((await documents.load(me, { artifactId: artifact })).text).toBe(PAGE_1);
});

test("with the artifact-web-pages flag off, no web page is made; documents are as before", async () => {
  webPages = false;
  try {
    const off = await post({
      operation: "create",
      kind: "html",
      title: "Early",
      description: "Too soon",
      target: `#growth-${handle}`,
      text: PAGE_1,
    });
    expect(off).toMatchObject({ status: 403, body: { code: "ACCESS_DENIED" } });
    expect(off.body.error).toContain("artifact-web-pages-off");
    const doc = await post({
      operation: "create",
      title: "Still fine",
      target: `#growth-${handle}`,
    });
    expect(doc).toMatchObject({ status: 200, body: { kind: "markdown" } });
  } finally {
    webPages = true;
  }
});

test("a web page needs a description, and a kind is markdown or html", async () => {
  const bare = await post({ operation: "create", kind: "html", title: "Bare", text: PAGE_1 });
  expect(bare).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  expect(bare.body.error).toContain("artifact-description-required");
  const pdf = await post({ operation: "create", kind: "pdf", title: "Pdf", description: "x" });
  expect(pdf).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  // A document is made as before, without a kind.
  const doc = await post({ operation: "create", title: "Notes", target: `#growth-${handle}` });
  expect(doc).toMatchObject({ status: 200, body: { kind: "markdown" } });
});
