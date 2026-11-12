import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { agentDirectKey } from "#src/features/conversations/direct-key";
import {
  Artifacts,
  type ArtifactActor,
  type ArtifactPublisher,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
  type ArtifactHome,
} from "#src/server/artifacts/artifacts.server";

/**
 * Who may read, write and delete an artifact (task #385): its home is its only access rule. A
 * conversation's artifact is read by whoever reads the conversation, a Workspace artifact by every
 * member; only an Agent writes one, and only where it is an active member of the conversation (or
 * anywhere in the Workspace). Deleting is a Workspace owner's or admin's; an Agent deletes only
 * its own. Nothing works while the Workspace has not switched the `artifacts` experiment on.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

const blobs = new Map<string, ArtifactBlobInfo>();
const store: ArtifactBlobStore = {
  inspectMany: async (_workspaceId, sha256s) =>
    new Map(sha256s.flatMap((sha) => (blobs.has(sha) ? [[sha, blobs.get(sha)!]] : []))),
  use: async () => [],
  read: async () => null,
  allowed: async (_workspaceId, _artifactId, _actor, sha256s) => new Set(sha256s),
};
let switchedOn = true;
const artifacts = new Artifacts(db, store, { enabled: async () => switchedOn });

let workspaceId: string;
let otherWorkspaceId: string;
const people: Record<"owner" | "admin" | "alice" | "bob" | "outsider", string> = {
  owner: "",
  admin: "",
  alice: "",
  bob: "",
  outsider: "",
};
const agents: Record<"helper" | "stranger" | "foreign", string> = {
  helper: "",
  stranger: "",
  foreign: "",
};
let publicChannel: string;
let privateChannel: string;
let dm: string;
let agentDm: string;

beforeAll(async () => {
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    const user = await db.user.create({
      data: { username: `aa-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: `aa-${handle}`,
      name: "Artifact access",
      members: {
        create: [
          { userId: people.owner, role: "owner" },
          { userId: people.admin, role: "admin" },
          { userId: people.alice, role: "member" },
          { userId: people.bob, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const other = await db.workspace.create({
    data: {
      slug: `aa-other-${handle}`,
      name: "Elsewhere",
      members: { create: { userId: people.outsider, role: "owner" } },
    },
  });
  otherWorkspaceId = other.id;
  const agent = (name: string, inWorkspace: string, ownerId: string) =>
    db.agent.create({
      data: {
        workspaceId: inWorkspace,
        name: `aa-${name}-${handle}`,
        displayName: name,
        ownerId,
        runtimeConfig: {},
      },
    });
  agents.helper = (await agent("helper", workspaceId, people.alice)).id;
  agents.stranger = (await agent("stranger", workspaceId, people.alice)).id;
  agents.foreign = (await agent("foreign", otherWorkspaceId, people.outsider)).id;

  const conversation = async (
    data: { channelName: string; visibility: string } | { directKey: string },
    members: ArtifactActor[],
  ) => {
    const { id } = await db.conversation.create({ data: { workspaceId, ...data } });
    await db.conversationMember.createMany({
      data: members.map((member) => ({ conversationId: id, workspaceId, ...member })),
    });
    return id;
  };
  const inChannel = [
    { userId: people.alice },
    { agentId: agents.helper },
  ] satisfies ArtifactActor[];
  publicChannel = await conversation(
    { channelName: `open-${handle}`, visibility: "public" },
    inChannel,
  );
  privateChannel = await conversation(
    { channelName: `closed-${handle}`, visibility: "private" },
    inChannel,
  );
  dm = await conversation({ directKey: `user:${people.alice}|user:${people.bob}` }, [
    { userId: people.alice },
    { userId: people.bob },
  ]);
  agentDm = await conversation({ directKey: agentDirectKey(people.alice, agents.helper) }, [
    { userId: people.alice },
    { agentId: agents.helper },
  ]);
  blobs.set("sha-doc", { kind: "text", sizeBytes: 100 });
  blobs.set("sha-doc-2", { kind: "text", sizeBytes: 120 });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await db.user.deleteMany({ where: { id: { in: Object.values(people) } } });
  await db.$disconnect();
});

let made = 0;
const create = (home: ArtifactHome, author: ArtifactPublisher) =>
  artifacts.create({
    workspaceId,
    home,
    name: `doc-${(made += 1)}-${handle}`,
    entryPath: "document.md",
    author,
  });
const push = (
  artifactId: string,
  publisher: ArtifactPublisher,
  sha256 = "sha-doc",
  baseVersion = 0,
) =>
  artifacts.push({
    workspaceId,
    artifactId,
    baseVersion,
    publisher,
    idempotencyKey: crypto.randomUUID(),
    files: [{ path: "document.md", sha256 }],
  });
const read = (artifactId: string, reader: ArtifactActor) =>
  artifacts.read({ workspaceId, artifactId, reader });
const inConversation = (conversationId: string): ArtifactHome => ({
  kind: "conversation",
  conversationId,
});

// Read when used: the ids exist once `beforeAll` has run.
const helper = {
  get agentId() {
    return agents.helper;
  },
};
const stranger = {
  get agentId() {
    return agents.stranger;
  },
};

test("with the experiment off, nothing is created, saved or read", async () => {
  const artifact = await create(inConversation(publicChannel), helper);
  switchedOn = false;
  try {
    const off = { code: "ACCESS_DENIED", errorId: "artifacts-disabled" };
    await expect(create({ kind: "workspace" }, helper)).rejects.toMatchObject(off);
    await expect(push(artifact.id, helper)).rejects.toMatchObject(off);
    await expect(read(artifact.id, { userId: people.alice })).rejects.toMatchObject(off);
  } finally {
    switchedOn = true;
  }
});

test("a public channel's artifact: every member reads, only an Agent that is in it saves", async () => {
  const artifact = await create(inConversation(publicChannel), helper);
  expect((await push(artifact.id, helper)).status).toBe("created");
  // Bob reads the public channel without being in it, and so reads its artifact.
  expect((await read(artifact.id, { userId: people.bob })).artifact.id).toBe(artifact.id);
  // An Agent of the Workspace reads a public channel too; outside it, it cannot save or make one.
  expect((await read(artifact.id, stranger)).artifact.id).toBe(artifact.id);
  await expect(push(artifact.id, stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(create(inConversation(publicChannel), stranger)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

test("a private channel's or a DM's artifact is unknown to whoever cannot read them", async () => {
  const closed = await create(inConversation(privateChannel), helper);
  const direct = await create(inConversation(agentDm), helper);
  for (const reader of [
    { userId: people.bob },
    { userId: people.owner },
    stranger,
  ] satisfies ArtifactActor[])
    await expect(read(closed.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await read(closed.id, { userId: people.alice })).artifact.id).toBe(closed.id);
  // A Workspace role grants nothing here: the owner is not in the DM.
  await expect(read(direct.id, { userId: people.owner })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await push(direct.id, helper)).status).toBe("created");
  await expect(create(inConversation(privateChannel), stranger)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  // People's DM with each other holds no artifact: no Agent is in it.
  await expect(create(inConversation(dm), helper)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a Workspace artifact is every Workspace Agent's to save, every member's to read, and nobody else's", async () => {
  const artifact = await create({ kind: "workspace" }, stranger);
  expect((await push(artifact.id, helper)).status).toBe("created");
  expect((await push(artifact.id, stranger, "sha-doc-2", 1)).status).toBe("created");
  expect((await read(artifact.id, { userId: people.bob })).artifact.id).toBe(artifact.id);
  for (const reader of [{ userId: people.outsider }, { agentId: agents.foreign }])
    await expect(read(artifact.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(create({ kind: "workspace" }, { agentId: agents.foreign })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a public home is not offered yet, and a conversation must be a channel or a DM here", async () => {
  await expect(create({ kind: "public" }, helper)).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-home",
  });
  await expect(create(inConversation(crypto.randomUUID()), helper)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("deleting is an owner's or admin's; an Agent deletes only its own", async () => {
  const del = (artifactId: string, actor: ArtifactActor) =>
    artifacts.delete({ workspaceId, artifactId, actor });
  const byHelper = await create({ kind: "workspace" }, helper);
  // A member who is neither the Workspace's owner nor admin, and another Agent, may not.
  await expect(del(byHelper.id, { userId: people.bob })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(del(byHelper.id, stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await del(byHelper.id, { userId: people.admin });
  await expect(read(byHelper.id, { userId: people.alice })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  const byStranger = await create({ kind: "workspace" }, stranger);
  await del(byStranger.id, stranger);
  const row = await db.artifact.findUniqueOrThrow({
    where: { id: byStranger.id },
    select: { deletedAt: true, deletedByAgentId: true },
  });
  expect(row.deletedAt).not.toBeNull();
  expect(row.deletedByAgentId).toBe(agents.stranger);
  // An owner or admin deletes only what they can read: a private channel they are not in keeps
  // its artifacts unknown to them, as it keeps its messages.
  const closed = await create(inConversation(privateChannel), helper);
  await expect(del(closed.id, { userId: people.owner })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("leaving a private channel ends access; an archived channel is read only; a hidden one is gone", async () => {
  const closed = await create(inConversation(privateChannel), helper);
  const open = await create(inConversation(publicChannel), helper);
  await db.conversationMember.updateMany({
    where: { conversationId: privateChannel, agentId: agents.helper },
    data: { leftAt: new Date() },
  });
  try {
    await expect(read(closed.id, helper)).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await db.conversationMember.updateMany({
      where: { conversationId: privateChannel, agentId: agents.helper },
      data: { leftAt: null },
    });
  }

  await db.conversation.update({ where: { id: publicChannel }, data: { archivedAt: new Date() } });
  try {
    expect((await read(open.id, { userId: people.alice })).artifact.id).toBe(open.id);
    await expect(push(open.id, helper)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally {
    await db.conversation.update({ where: { id: publicChannel }, data: { archivedAt: null } });
  }

  await db.conversation.update({
    where: { id: publicChannel },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    await expect(read(open.id, { userId: people.alice })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await db.conversation.update({
      where: { id: publicChannel },
      data: { hiddenFromWorkspaceAt: null },
    });
  }
});

test("with the experiment off, a bad request and a delete hear only that it is off", async () => {
  const artifact = await create({ kind: "workspace" }, helper);
  switchedOn = false;
  try {
    const off = { code: "ACCESS_DENIED", errorId: "artifacts-disabled" };
    await expect(
      artifacts.create({
        workspaceId,
        home: { kind: "workspace" },
        name: "Not A Valid Name",
        entryPath: "document.md",
        author: helper,
      }),
    ).rejects.toMatchObject(off);
    await expect(
      artifacts.delete({ workspaceId, artifactId: artifact.id, actor: { userId: people.owner } }),
    ).rejects.toMatchObject(off);
  } finally {
    switchedOn = true;
  }
});
