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
 * `POST /api/agent/v1/artifacts` (task #385, step 5): an Agent's documents, by the web page's
 * rules. The experiment is answered first, a home the Agent cannot read is missing, and a save's
 * internal options cannot be sent.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let root: string;
let enabled = true;
let documents: ArtifactDocuments;
let artifacts: Artifacts;
let workspaceId: string;
let alice: string;
let agentId: string;
let secretId: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-artifacts-"));
  const storage = new LocalFileStorage(root);
  const blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => enabled });
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
    { db, artifacts, documents, enabled: async () => enabled },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const key = () => crypto.randomUUID();

test("an Agent in a channel creates, reads, saves, pages and reverts a document there", async () => {
  const created = await post({
    operation: "create",
    title: "Launch plan",
    target: `#launch-${handle}`,
    text: "# Launch plan\n\nShip in May.\n\nRisks: none.\n",
  });
  expect(created).toMatchObject({ status: 200, body: { name: "launch-plan", currentVersion: 1 } });
  const artifact = created.body.id as string;

  const read = await post({ operation: "read", artifact });
  expect(read.body.text).toBe("# Launch plan\n\nShip in May.\n\nRisks: none.\n");

  const saved = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    text: "# Launch plan\n\nShip in June.\n\nRisks: none.\n",
    note: "moved a month",
  });
  expect(saved.body).toMatchObject({ status: "created" });

  // A save over version 1 that changes the same paragraph again: nothing is written.
  const conflict = await post({
    operation: "push",
    artifact,
    baseVersion: 1,
    idempotencyKey: key(),
    text: "# Launch plan\n\nShip in July.\n\nRisks: none.\n",
  });
  expect(conflict).toMatchObject({ status: 200, body: { status: "conflict", currentVersion: 2 } });
  expect(conflict.body.files[0].path).toBe("document.md");

  const history = await post({ operation: "history", artifact, limit: 1 });
  expect(history.body.versions).toHaveLength(1);
  expect(history.body.nextBefore).toBe(2);

  const reverted = await post({
    operation: "revert",
    artifact,
    to: 1,
    baseVersion: 2,
    idempotencyKey: key(),
  });
  expect(reverted.body).toMatchObject({ status: "created" });
  expect((await post({ operation: "read", artifact })).body.text).toContain("Ship in May.");
});

test("an Agent makes a document in its DM with a person", async () => {
  const created = await post({ operation: "create", title: "Notes", target: `dm:@ag-a-${handle}` });
  expect(created).toMatchObject({ status: 200, body: { currentVersion: 0 } });
});

test("an Agent names a DM as message send does, and makes Workspace documents", async () => {
  expect(
    await post({ operation: "create", title: "Notes", target: `@ag-a-${handle}~human` }),
  ).toMatchObject({ status: 200 });
  // No DM with this Agent exists, and none is opened for a document.
  expect(
    await post({ operation: "create", title: "Notes", target: `@ag-bot-${handle}~agent` }),
  ).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
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
    expect(
      await post({ operation: "create", title: "Notes", target: `@ag-a-${handle}` }),
    ).toMatchObject({ status: 409, body: { code: "AMBIGUOUS_TARGET" } });
    expect(
      await post({ operation: "create", title: "Notes", target: `@ag-a-${handle}~human` }),
    ).toMatchObject({ status: 200 });
  } finally {
    await db.agent.delete({ where: { id: twin.id } });
  }
  expect(await post({ operation: "create", title: "Handbook", text: "# Hi\n" })).toMatchObject({
    status: 200,
    body: { currentVersion: 1 },
  });
});

test("a channel the Agent reads but may not write refuses a document", async () => {
  // A public channel it is not in, and an archived one it is in.
  for (const target of [`#lobby-${handle}`, `#old-${handle}`])
    expect(await post({ operation: "create", title: "Plan", target })).toMatchObject({
      status: 403,
      body: { code: "ACCESS_DENIED" },
    });
});

test("a channel the Agent cannot read is missing, for making and for reading", async () => {
  expect(
    await post({ operation: "create", title: "Secret", target: `#secret-${handle}` }),
  ).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
  const secret = await documents.create(
    { workspaceId, actor: { userId: alice } },
    { conversationId: secretId, title: "Secret", text: "hush\n" },
  );
  expect(await post({ operation: "read", artifact: secret.id })).toMatchObject({
    status: 404,
    body: { code: "NOT_FOUND" },
  });
});

test("a request outside the web page's rules is refused", async () => {
  for (const body of [
    { operation: "push", artifact: key(), baseVersion: 0, idempotencyKey: key(), exactBase: true },
    { operation: "read", artifact: "not-an-id" },
    { operation: "history", artifact: key(), limit: 51 },
    { operation: "create", title: "   " },
    { operation: "create", title: "Plan", text: "a\u0000b" },
  ])
    expect(await post(body)).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  // The refusal names the field.
  expect(await post({ operation: "history", artifact: key(), limit: 51 })).toMatchObject({
    body: { error: expect.stringContaining("limit is not accepted") },
  });
  expect(
    await post({ operation: "create", title: "Plan", target: `#launch-${handle}:01a199fb` }),
  ).toMatchObject({ status: 400, body: { error: expect.stringContaining("artifact-target") } });
});

test("a Workspace without documents says so, whatever was asked", async () => {
  enabled = false;
  try {
    for (const body of [
      { operation: "create", title: "Plan", target: "#nowhere" },
      { operation: "read", artifact: key() },
    ])
      expect(await post(body)).toMatchObject({
        status: 403,
        body: { code: "ACCESS_DENIED", error: expect.stringContaining("artifacts-disabled") },
      });
  } finally {
    enabled = true;
  }
});
