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
import { handleAgentArtifactPost } from "#src/routes/api/agent/v1/artifacts";

/**
 * Moving an artifact to the Workspace and deleting it: an Agent's `move` and `delete` by the
 * route, a person's change of its tier and the count of who would lose it.
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
const people = { owner: "", admin: "", alice: "", bob: "", carol: "" };
const agents = { bot: "", peer: "", bobBot: "", carolBot: "" };
let room: string;
let bobRoom: string;
let carolRoom: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "artifact-manage-"));
  const storage = new LocalFileStorage(root);
  blobs = new StoredArtifactBlobs(db, async () => storage);
  artifacts = new Artifacts(db, blobs, { enabled: async () => true });
  documents = new ArtifactDocuments(db, artifacts, blobs);
  for (const name of Object.keys(people) as (keyof typeof people)[])
    people[name] = (
      await db.user.create({ data: { username: `am-${name}-${handle}`, displayName: name } })
    ).id;
  workspaceId = (
    await db.workspace.create({
      data: {
        slug: `am-${handle}`,
        name: "Manage",
        members: {
          create: [
            { userId: people.owner, role: "owner" },
            { userId: people.admin, role: "admin" },
            { userId: people.alice, role: "member" },
            { userId: people.bob, role: "member" },
            { userId: people.carol, role: "member" },
          ],
        },
      },
    })
  ).id;
  const agent = async (name: string, ownerId: string) =>
    (
      await db.agent.create({
        data: {
          workspaceId,
          name: `am-${name}-${handle}`,
          displayName: name,
          ownerId,
          runtimeConfig: {},
        },
      })
    ).id;
  agents.bot = await agent("bot", people.alice);
  agents.peer = await agent("peer", people.alice);
  agents.bobBot = await agent("bobbot", people.bob);
  agents.carolBot = await agent("carolbot", people.carol);
  const conversation = async (name: string, members: object[]) => {
    const { id } = await db.conversation.create({
      data: { workspaceId, channelName: `${name}-${handle}`, visibility: "private" },
    });
    await db.conversationMember.createMany({
      data: members.map((member) => ({ conversationId: id, workspaceId, ...member })),
    });
    return id;
  };
  room = await conversation("room", [
    { userId: people.alice },
    { userId: people.bob },
    { agentId: agents.bot },
    { agentId: agents.peer },
  ]);
  bobRoom = await conversation("bobroom", [{ agentId: agents.bobBot }]);
  carolRoom = await conversation("carolroom", [{ agentId: agents.carolBot }]);
});

afterAll(async () => {
  await db.workspace.delete({ where: { id: workspaceId } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: Object.values(people) } } });
  await db.$disconnect();
  await rm(root, { recursive: true, force: true });
});

const post = async (agentId: string, body: unknown) => {
  const response = await handleAgentArtifactPost(
    new Request("http://local/api/agent/v1/artifacts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { workspaceId, agentId },
    { db, documents, blobs, enabled: async () => true },
  );
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

let made = 0;
const make = async (agentId: string, conversationId: string) => {
  const created = await documents.create(
    { workspaceId, actor: { agentId } },
    {
      conversationId,
      title: `Doc ${(made += 1)} ${handle}`,
      manifest: {
        files: [
          {
            path: "document.md",
            sha256: (
              await blobs.upload({
                workspaceId,
                bytes: new TextEncoder().encode("hello\n") as Uint8Array<ArrayBuffer>,
                actor: { agentId },
              })
            ).sha256,
          },
        ],
      },
    },
  );
  return created.id;
};
const tierOf = async (id: string) =>
  (await db.artifact.findUniqueOrThrow({ where: { id } })).access;
const events = (artifactId: string) =>
  db.artifactAccessEvent.findMany({ where: { artifactId }, orderBy: { createdAt: "asc" } });

test("the author Agent moves its artifact to the Workspace, and it is then everyone's", async () => {
  const id = await make(agents.bot, room);
  const moved = await post(agents.bot, { operation: "move", artifact: id, to: "workspace" });
  expect(moved).toMatchObject({
    status: 200,
    body: { artifact: { id }, from: "conversation", to: "workspace" },
  });
  expect(await tierOf(id)).toBe("workspace");
  expect(await events(id)).toMatchObject([
    { from: "conversation", to: "workspace", actorAgentId: agents.bot },
  ]);
  expect((await post(agents.carolBot, { operation: "read", artifact: id })).status).toBe(200);
  const again = await post(agents.bot, { operation: "move", artifact: id, to: "workspace" });
  expect(again.status).toBe(409);
  expect(again.body.error).toContain("artifact-home-not-wider");
});

test("only the author Agent moves it, and nothing but the Workspace is a destination", async () => {
  const id = await make(agents.bot, room);
  const notAuthor = await post(agents.peer, { operation: "move", artifact: id, to: "workspace" });
  expect(notAuthor.status).toBe(403);
  expect(notAuthor.body.error).toContain("artifact-move-not-author");
  const outsider = await post(agents.carolBot, {
    operation: "move",
    artifact: id,
    to: "workspace",
  });
  expect(outsider.status).toBe(404);
  const toPublic = await post(agents.bot, { operation: "move", artifact: id, to: "public" });
  expect(toPublic.status).toBe(403);
  expect(toPublic.body.error).toContain("artifact-move-public");
  const unknown = await post(agents.bot, { operation: "move", artifact: id, to: "elsewhere" });
  expect(unknown.status).toBe(400);
  expect(await tierOf(id)).toBe("conversation");
  expect(await events(id)).toEqual([]);
});

test("a move is refused when the Agent's owner cannot see the artifact or is not a member any more", async () => {
  const unseen = await make(agents.bobBot, bobRoom);
  const cannotSee = await post(agents.bobBot, {
    operation: "move",
    artifact: unseen,
    to: "workspace",
  });
  expect(cannotSee.status).toBe(403);
  expect(cannotSee.body.details).toEqual({ reason: "owner-cannot-see" });
  const orphan = await make(agents.carolBot, carolRoom);
  await db.workspaceMembership.delete({
    where: { workspaceId_userId: { workspaceId, userId: people.carol } },
  });
  const noOwner = await post(agents.carolBot, {
    operation: "move",
    artifact: orphan,
    to: "workspace",
  });
  expect(noOwner.status).toBe(403);
  expect(noOwner.body.details).toEqual({ reason: "no-owner" });
  expect(await tierOf(unseen)).toBe("conversation");
  expect(await tierOf(orphan)).toBe("conversation");
});

test("only the author Agent deletes its artifact, and deleting again finds nothing", async () => {
  const id = await make(agents.bot, room);
  const other = await post(agents.peer, { operation: "delete", artifact: id });
  expect(other.status).toBe(403);
  const outsider = await post(agents.bobBot, { operation: "delete", artifact: id });
  expect(outsider.status).toBe(404);
  const deleted = await post(agents.bot, { operation: "delete", artifact: id });
  expect(deleted).toMatchObject({ status: 200, body: { artifact: { id }, deleted: true } });
  expect((await post(agents.bot, { operation: "delete", artifact: id })).status).toBe(404);
  expect((await post(agents.bot, { operation: "read", artifact: id })).status).toBe(404);
});

test("a person changes the tier when they own the author or administer the Workspace, and narrows only to a home they can read", async () => {
  const id = await make(agents.bot, room);
  const change = (userId: string, tier: "conversation" | "workspace") =>
    artifacts.visibility.change({ workspaceId, artifactId: id, userId, tier });
  const before = (await db.artifact.findUniqueOrThrow({ where: { id } })).updatedAt;
  await expect(change(people.bob, "workspace")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(change(people.carol, "workspace")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await change(people.alice, "workspace")).toMatchObject({
    from: "conversation",
    to: "workspace",
  });
  await expect(change(people.bob, "conversation")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(change(people.admin, "conversation")).rejects.toMatchObject({
    code: "NOT_FOUND",
    errorId: "artifact-home-unseen",
    hint: "You can no longer see that conversation, so it can't go back.",
  });
  await expect(
    artifacts.visibility.loss({ workspaceId, artifactId: id, userId: people.admin }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", errorId: "artifact-home-unseen" });
  await db.conversationMember.create({
    data: { conversationId: room, workspaceId, userId: people.admin },
  });
  try {
    expect(await change(people.admin, "conversation")).toMatchObject({
      from: "workspace",
      to: "conversation",
    });
  } finally {
    await db.conversationMember.deleteMany({
      where: { conversationId: room, userId: people.admin },
    });
  }
  await expect(change(people.owner, "workspace")).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await change(people.alice, "conversation")).toMatchObject({
    from: "conversation",
    to: "conversation",
  });
  expect((await events(id)).map((event) => [event.from, event.to, event.actorUserId])).toEqual([
    ["conversation", "workspace", people.alice],
    ["workspace", "conversation", people.admin],
  ]);
  expect((await db.artifact.findUniqueOrThrow({ where: { id } })).updatedAt).toEqual(before);
});

test("narrowing needs a home that still stands, and the loss counts who would stop seeing it", async () => {
  const id = await make(agents.bot, room);
  await artifacts.visibility.change({
    workspaceId,
    artifactId: id,
    userId: people.alice,
    tier: "workspace",
  });
  const loss = await artifacts.visibility.loss({
    workspaceId,
    artifactId: id,
    userId: people.alice,
  });
  expect(loss.people).toBeGreaterThanOrEqual(2);
  expect(loss.agents).toBeGreaterThanOrEqual(2);
  await expect(
    artifacts.visibility.loss({ workspaceId, artifactId: id, userId: people.bob }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await db.conversation.update({
    where: { id: room },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    await expect(
      artifacts.visibility.change({
        workspaceId,
        artifactId: id,
        userId: people.alice,
        tier: "conversation",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      artifacts.visibility.loss({ workspaceId, artifactId: id, userId: people.alice }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await db.conversation.update({ where: { id: room }, data: { hiddenFromWorkspaceAt: null } });
  }
  expect(await tierOf(id)).toBe("workspace");
});

const widen = async (id: string) =>
  artifacts.visibility.change({
    workspaceId,
    artifactId: id,
    userId: people.alice,
    tier: "workspace",
  });
const narrow = (id: string, expectedLost?: number) =>
  artifacts.visibility.change({
    workspaceId,
    artifactId: id,
    userId: people.alice,
    tier: "conversation",
    expectedLost,
  });
const preview = (id: string) =>
  artifacts.visibility.loss({ workspaceId, artifactId: id, userId: people.alice });

test("narrowing is refused while its author Agent is not in the home, and while it cannot see it", async () => {
  const id = await make(agents.bot, room);
  await widen(id);
  await db.conversationMember.updateMany({
    where: { conversationId: room, agentId: agents.bot },
    data: { leftAt: new Date() },
  });
  try {
    await expect(narrow(id)).rejects.toMatchObject({
      code: "CONFLICT",
      errorId: "artifact-author-not-member",
    });
    await expect(preview(id)).rejects.toMatchObject({ errorId: "artifact-author-not-member" });
  } finally {
    await db.conversationMember.updateMany({
      where: { conversationId: room, agentId: agents.bot },
      data: { leftAt: null },
    });
  }
  await db.agent.update({ where: { id: agents.bot }, data: { deletedAt: new Date() } });
  try {
    await expect(narrow(id)).rejects.toMatchObject({
      code: "CONFLICT",
      errorId: "artifact-author-cannot-see",
    });
    await expect(preview(id)).rejects.toMatchObject({ errorId: "artifact-author-cannot-see" });
  } finally {
    await db.agent.update({ where: { id: agents.bot }, data: { deletedAt: null } });
  }
  expect(await tierOf(id)).toBe("workspace");
  expect(await narrow(id)).toMatchObject({ to: "conversation" });
});

test("narrowing commits only for the count that was shown, and turns the public link off", async () => {
  const id = await make(agents.bot, room);
  await widen(id);
  const shown = await preview(id);
  const expectedLost = shown.people + shown.agents;
  const late = (
    await db.agent.create({
      data: {
        workspaceId,
        name: `am-late-${handle}`,
        displayName: "late",
        ownerId: people.alice,
        runtimeConfig: {},
      },
    })
  ).id;
  try {
    await expect(narrow(id, expectedLost)).rejects.toMatchObject({
      code: "CONFLICT",
      errorId: "artifact-loss-changed",
    });
    expect(await tierOf(id)).toBe("workspace");
  } finally {
    await db.agent.update({ where: { id: late }, data: { deletedAt: new Date() } });
  }
  await db.artifactPublicLink.create({
    data: { artifactId: id, token: crypto.randomUUID(), createdByUserId: people.alice },
  });
  expect(await narrow(id, expectedLost)).toMatchObject({ to: "conversation" });
  expect(await db.artifactPublicLink.count({ where: { artifactId: id, revokedAt: null } })).toBe(0);
});
