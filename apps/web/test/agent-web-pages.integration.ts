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
 * Web pages (task #490): an artifact whose entry file is html. An Agent pushes one (a description
 * is optional), reads its source, and pushes over it; a push over a version someone else moved
 * past is merged by file, and refused where the same file changed, never merged inside it. A
 * person only reads it. What an Agent pushed is what the sandbox origin serves.
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
    { db, documents, enabled: async () => true },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const key = () => crypto.randomUUID();

/** The `index.html` file of some source, uploaded by the Agent and named as a manifest. */
async function page(html: string) {
  const { sha256 } = await blobs.upload({
    workspaceId,
    bytes: new TextEncoder().encode(html) as Uint8Array<ArrayBuffer>,
    actor: { agentId },
  });
  return [{ path: "index.html", sha256 }];
}

const PAGE_1 = "<!doctype html><h1>Signups</h1><script>document.title = 'v1'</script>";
const PAGE_2 = "<!doctype html><h1>Signups and activation</h1>";

test("an Agent makes a web page, reads its source, and pushes it whole", async () => {
  const created = await post({
    operation: "push",
    title: "Signup funnel",
    description: "Signups by day, with a toggle per channel",
    target: `#growth-${handle}`,
    files: await page(PAGE_1),
    idempotencyKey: key(),
  });
  expect(created).toMatchObject({
    status: 200,
    body: { name: "signup-funnel", entryPath: "index.html", currentVersion: 1 },
  });
  const artifact = created.body.id as string;
  const read = await post({ operation: "read", artifact });
  expect(read.body).toMatchObject({
    text: PAGE_1,
    artifact: {
      entryPath: "index.html",
      description: "Signups by day, with a toggle per channel",
    },
  });
  // A person reads the same source.
  const me = { workspaceId, actor: { userId: alice } };
  expect((await documents.load(me, { artifactId: artifact })).text).toBe(PAGE_1);

  // Its card line is its description, not its source.
  expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact } })).preview).toBe(
    "Signups by day, with a toggle per channel",
  );

  const saved = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await page(PAGE_2),
  });
  expect(saved.body).toMatchObject({ status: "created", number: 2 });

  // Over version 1 again: someone pushed the same file since, and a file is never merged inside.
  // Nothing is written.
  const stale = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await page("<!doctype html><h1>Mine</h1>"),
  });
  expect(stale).toMatchObject({ status: 409, body: { code: "CONFLICT" } });
  expect(stale.body.error).toContain("artifact-base-moved");
  expect((await post({ operation: "read", artifact })).body.text).toBe(PAGE_2);

  // Only the description moved since version 2: a push of the page over version 2 keeps it, as
  // settings merge item by item.
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
    files: await page("<!doctype html><h1>Mine</h1>"),
  });
  expect(overSettings.body).toMatchObject({
    status: "created",
    number: 4,
    mergedSettings: ["description"],
  });
  expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact } })).description).toBe(
    "Signups and activation by day",
  );

  // The sandbox serves exactly what was pushed.
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
  const served = await sandbox.serve(
    new Request(`${link.url}/page/index.html`, {
      headers: { "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "same-origin" },
    }),
  );
  expect(await served.text()).toEndWith("<h1>Mine</h1>");
});

test("a web page needs no description, and its type is its entry file's, not a stated kind", async () => {
  const bare = await post({
    operation: "push",
    title: "Bare",
    files: await page(PAGE_1),
    idempotencyKey: key(),
  });
  expect(bare).toMatchObject({ status: 200, body: { entryPath: "index.html", preview: "" } });
  // A stated kind is outside the contract.
  const stated = await post({
    operation: "push",
    kind: "html",
    title: "Stated",
    files: await page(PAGE_1),
    idempotencyKey: key(),
  });
  expect(stated).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
});
