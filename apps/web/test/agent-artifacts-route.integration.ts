import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import { Artifacts } from "#src/server/artifacts/artifacts.server";
import { StoredArtifactBlobs } from "#src/server/artifacts/artifact-blobs.server";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import { LocalFileStorage } from "#src/server/files/file-storage.server";
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * `POST /api/agent/v1/artifacts` (task #385, step 5): an Agent's artifacts, by the web page's
 * rules. An Agent writes only by `push` (a push with no artifact makes one). The experiment is
 * answered first, a home the Agent cannot read is missing, and a save's internal options cannot
 * be sent.
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
let insiderId: string;
let secretId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-artifacts-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs);
  documents = new ArtifactDocuments(db, artifacts, blobs);
  alice = (await db.user.create({ data: { username: `ag-a-${handle}`, displayName: "Alice" } })).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `ag-${handle}`,
        name: "Docs",
        members: { create: [{ userId: alice, role: "owner" }] },
      },
    })
  ).id;
  agentId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `ag-bot-${handle}`,
        displayName: "Bot",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  insiderId = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `ag-insider-${handle}`,
        displayName: "Insider",
        ownerId: alice,
        runtimeConfig: {},
      },
    })
  ).id;
  const conversation = async (
    data: { channelName?: string; visibility?: string; directKey?: string },
    members: ({ userId: string } | { agentId: string })[],
  ) => {
    const { id } = await db.conversation.create({ data: { workspaceId, ...data } });
    await db.conversationMember.createMany({
      data: members.map((member) => ({ conversationId: id, workspaceId, ...member })),
    });
    return id;
  };
  await conversation({ channelName: `launch-${handle}`, visibility: "public" }, [
    { userId: alice },
    { agentId },
  ]);
  secretId = await conversation({ channelName: `secret-${handle}`, visibility: "private" }, [
    { userId: alice },
    { agentId: insiderId },
  ]);
  await conversation({ channelName: `lobby-${handle}`, visibility: "public" }, [{ userId: alice }]);
  const archived = await conversation({ channelName: `old-${handle}`, visibility: "public" }, [
    { userId: alice },
    { agentId },
  ]);
  await db.conversation.update({ where: { id: archived }, data: { archivedAt: new Date() } });
  await conversation({ directKey: agentDirectKey(alice, agentId) }, [
    { userId: alice },
    { agentId },
  ]);
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
    { db, documents, blobs },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const key = () => crypto.randomUUID();

/** Uploads each file's text as `agent` and names them as a manifest. */
async function put(files: Record<string, string>, agent = agentId) {
  return Promise.all(
    Object.entries(files).map(async ([path, text]) => ({
      path,
      sha256: (
        await blobs.upload({
          workspaceId,
          bytes: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>,
          actor: { agentId: agent },
        })
      ).sha256,
    })),
  );
}

/** A push with no artifact: it makes one. */
const make = async (title: string, files: Record<string, string>, extra: object = {}) => ({
  operation: "push",
  title,
  target: `#launch-${handle}`,
  idempotencyKey: key(),
  files: await put(files),
  ...extra,
});

test("an Agent in a channel makes an artifact there, reads it, pushes over it and is refused a clash", async () => {
  const created = await post(
    await make(
      "Launch plan",
      { "plan.md": "# Launch plan\n\nShip in May.\n\nRisks: none.\n" },
      { target: `#launch-${handle}` },
    ),
  );
  expect(created).toMatchObject({ status: 200, body: { name: "launch-plan", currentVersion: 1 } });
  const artifact = created.body.id as string;

  const read = await post({ operation: "read", artifact });
  expect(read.body.text).toBe("# Launch plan\n\nShip in May.\n\nRisks: none.\n");
  expect(read.body).toMatchObject({
    canDelete: true,
    artifact: { homeKind: "channel", access: "conversation" },
  });
  expect(read.body.artifact).not.toHaveProperty("kind");

  // The read-only list finds the artifact in its channel, newest first.
  const listed = await post({ operation: "list", target: `#launch-${handle}` });
  expect(listed.status).toBe(200);
  expect((listed.body as unknown as { id: string }[]).map((row) => row.id)).toContain(artifact);

  const saved = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await put({ "plan.md": "# Launch plan\n\nShip in June.\n\nRisks: none.\n" }),
    note: "moved a month",
  });
  expect(saved.body).toMatchObject({ status: "created" });

  // A push over version 1 that changes the file version 2 changed is never merged inside the
  // file: it is refused, naming the file.
  const conflict = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await put({ "plan.md": "# Launch plan\n\nShip in July.\n\nRisks: none.\n" }),
  });
  expect(conflict.status).toBe(409);
  expect(conflict.body).toMatchObject({ code: "CONFLICT", retryable: false });
  expect(conflict.body.error).toContain("artifact-base-moved");
  expect(conflict.body.details).toEqual({ files: "plan.md" });
});

test("an Agent's other files survive a push over an older version that changes a different file", async () => {
  const created = await post(
    await make("Two files", { "a.md": "a\n", "b.md": "b\n" }, { entry: "a.md" }),
  );
  const artifact = created.body.id as string;
  await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await put({ "b.md": "b2\n" }),
  });
  const merged = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await put({ "a.md": "a2\n" }),
  });
  expect(merged.body).toMatchObject({ status: "created", number: 3, merged: ["b.md"] });
});

test("a retried Agent push replays its version even after the artifact moved on", async () => {
  const created = await post(await make("Plan", { "plan.md": "one\n" }));
  const artifact = created.body.id as string;
  const push = {
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    files: await put({ "plan.md": "two\n" }),
  };
  const saved = await post(push);
  expect(saved.body).toMatchObject({ status: "created", number: 2 });
  // Someone else saves before the first push's retry lands.
  await post({
    operation: "push",
    artifact,
    baseVersion: 2,
    idempotencyKey: key(),
    files: await put({ "plan.md": "three\n" }),
  });
  const retried = await post(push);
  expect(retried.status).toBe(200);
  expect(retried.body).toMatchObject({ status: "replayed", number: 2 });
});

test("an Agent makes an artifact in its DM with a person", async () => {
  const created = await post(
    await make("Notes", { "notes.md": "n\n" }, { target: `dm:@ag-a-${handle}` }),
  );
  expect(created).toMatchObject({ status: 200, body: { currentVersion: 1 } });
});

test("an Agent names a DM as message send does", async () => {
  const notes = (target: string) => make("Notes", { "notes.md": "n\n" }, { target });
  expect(await post(await notes(`@ag-a-${handle}~human`))).toMatchObject({ status: 200 });
  // No DM with this Agent exists, and none is opened for an artifact.
  expect(await post(await notes(`@ag-bot-${handle}~agent`))).toMatchObject({
    status: 404,
    body: { code: "NOT_FOUND" },
  });
  // A name a person and another Agent share is refused bare, as message send refuses it.
  const twin = await db.agent.create({
    data: {
      workspaceId,
      name: `ag-a-${handle}`,
      displayName: "Twin",
      ownerId: alice,
      runtimeConfig: {},
    },
  });
  try {
    expect(await post(await notes(`@ag-a-${handle}`))).toMatchObject({
      status: 409,
      body: { code: "AMBIGUOUS_TARGET" },
    });
    expect(await post(await notes(`@ag-a-${handle}~human`))).toMatchObject({ status: 200 });
  } finally {
    await db.agent.delete({ where: { id: twin.id } });
  }
});

test("a new artifact needs a home: a push with no target is refused, naming how to give one", async () => {
  const { target: _target, ...bare } = await make("Handbook", { "handbook.md": "# Hi\n" });
  const before = await db.artifact.count({ where: { workspaceId } });
  const refused = await post(bare);
  expect(refused).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  expect(refused.body.error).toContain("artifact-target-required");
  expect(JSON.stringify(refused.body)).toContain("--target");
  expect(await db.artifact.count({ where: { workspaceId } })).toBe(before);
});

test("a thread target homes the artifact in its channel, and lists its channel's", async () => {
  const created = await post(
    await make("Threaded", { "t.md": "t\n" }, { target: `#launch-${handle}:01a199fb` }),
  );
  expect(created.status).toBe(200);
  const row = await db.artifact.findUniqueOrThrow({ where: { id: created.body.id } });
  const channel = await db.conversation.findFirstOrThrow({
    where: { workspaceId, channelName: `launch-${handle}` },
  });
  expect(row.homeKey).toBe(`conversation:${channel.id}`);
  const listed = await post({ operation: "list", target: `#launch-${handle}:01a199fb` });
  expect((listed.body as unknown as { id: string }[]).map((entry) => entry.id)).toContain(
    created.body.id,
  );
});

test("a task is refused as a home, naming the conversation it is on", async () => {
  for (const [target, named] of [
    [`#launch-${handle}:#7`, `#launch-${handle}`],
    [`dm:@ag-a-${handle}:#7`, `@ag-a-${handle}`],
  ] as const) {
    const refused = await post(await make("Task notes", { "n.md": "n\n" }, { target }));
    expect(refused).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
    expect(refused.body.error).toContain("artifact-target-task");
    expect(JSON.stringify(refused.body)).toContain(named);
  }
});

test("a channel the Agent reads but may not write refuses an artifact", async () => {
  // A public channel it is not in, and an archived one it is in.
  for (const target of [`#lobby-${handle}`, `#old-${handle}`])
    expect(await post(await make("Plan", { "plan.md": "p\n" }, { target }))).toMatchObject({
      status: 403,
      body: { code: "ACCESS_DENIED" },
    });
});

test("an idempotent create replays over the Agent API, and a reused key with other files conflicts", async () => {
  const idempotencyKey = key();
  const create = async (text: string) =>
    post(await make("Retry plan", { "retry.md": text }, { idempotencyKey }));
  const first = await create("# Retry\n\nOnce.\n");
  expect(first.status).toBe(200);
  const replay = await create("# Retry\n\nOnce.\n");
  expect(replay.status).toBe(200);
  expect(replay.body.id).toBe(first.body.id);
  expect(replay.body.currentVersion).toBe(first.body.currentVersion);
  // The same key with different files is refused, nothing new made.
  expect((await create("# Retry\n\nTwice.\n")).status).toBe(409);
});

test("bytes the Agent never uploaded are asked for before an artifact is made", async () => {
  const before = await db.artifact.count({ where: { workspaceId } });
  const sha256 = "d".repeat(64);
  const asked = await post({
    operation: "push",
    target: `#launch-${handle}`,
    title: "Not yet",
    idempotencyKey: key(),
    files: [{ path: "plan.md", sha256 }],
  });
  expect(asked).toMatchObject({ status: 200, body: { status: "missing", missing: [sha256] } });
  expect(await db.artifact.count({ where: { workspaceId } })).toBe(before);
});

test("a channel the Agent cannot read is missing for making, and so is its artifact until it is widened", async () => {
  expect(
    await post(await make("Secret", { "secret.md": "s\n" }, { target: `#secret-${handle}` })),
  ).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  const secret = await documents.create(
    { workspaceId, actor: { agentId: insiderId } },
    {
      conversationId: secretId,
      title: "Secret",
      manifest: { files: await put({ "secret.md": "hush\n" }, insiderId) },
    },
  );
  const push = async () =>
    post({
      operation: "push",
      artifact: secret.id,
      baseVersion: 1,
      idempotencyKey: key(),
      files: await put({ "secret.md": "changed\n" }),
    });
  expect(await post({ operation: "read", artifact: secret.id })).toMatchObject({
    status: 404,
    body: { code: "NOT_FOUND" },
  });
  expect(await push()).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  await documents.moveToWorkspace(
    { workspaceId, actor: { agentId: insiderId } },
    { artifactId: secret.id },
  );
  const read = await post({ operation: "read", artifact: secret.id });
  expect(read.status).toBe(200);
  expect(read.body.artifact).toMatchObject({
    homeKey: "workspace",
    homeKind: "workspace",
    access: "workspace",
  });
  expect(await push()).toMatchObject({ status: 200, body: { status: "created" } });
});

test("a request outside the web page's rules is refused", async () => {
  const files = await put({ "plan.md": "p\n" });
  for (const body of [
    { operation: "push", artifact: key(), baseVersion: 0, idempotencyKey: key(), exactBase: true },
    { operation: "list", limit: 51 },
    { operation: "push", title: "   ", idempotencyKey: key(), files },
    { operation: "push", title: "Plan", idempotencyKey: "not-a-key", files },
    // Removed operations, and the single-text form of a push.
    { operation: "create", title: "Plan", files },
    { operation: "history", artifact: key() },
    { operation: "revert", artifact: key(), to: 1, baseVersion: 2, idempotencyKey: key() },
    { operation: "push", artifact: key(), baseVersion: 1, idempotencyKey: key(), text: "x" },
  ])
    expect(await post(body)).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  expect(await post({ operation: "read", artifact: "not-an-id" })).toMatchObject({ status: 404 });
  // The refusal names the field.
  expect(await post({ operation: "list", limit: 51 })).toMatchObject({
    body: { error: expect.stringContaining("limit is not accepted") },
  });
  expect(
    await post(await make("Plan", { "plan.md": "p\n" }, { target: `#launch-${handle}:#abc` })),
  ).toMatchObject({ status: 400, body: { error: expect.stringContaining("artifact-target") } });
});
