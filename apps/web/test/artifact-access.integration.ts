import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  ARTIFACT_DOCUMENT_LIMIT,
  Artifacts,
  type ArtifactActor,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
  type ArtifactHome,
} from "#src/server/artifacts/artifacts.server";

/**
 * Who may read, write and delete an artifact (task #385): its home is its only access rule. A
 * conversation's artifact is read by whoever reads the conversation and written by its active
 * members, people and Agents alike; a Workspace artifact by every member. Deleting is its
 * author's, or a Workspace owner's or admin's; an Agent deletes only its own. Nothing works while
 * the Workspace has not switched the `artifacts` experiment on.
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
  // These artifacts are not documents, so no save reads or merges their bytes.
  read: async () => null,
  allowed: async (_workspaceId, _artifactId, _actor, sha256s) => new Set(sha256s),
  upload: async () => {
    throw new Error("no bytes are stored in this test");
  },
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
  blobs.set("sha-doc", { kind: "text", sizeBytes: 100 });
  blobs.set("sha-doc-2", { kind: "text", sizeBytes: 120 });
  blobs.set("sha-big", { kind: "text", sizeBytes: ARTIFACT_DOCUMENT_LIMIT + 1 });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await db.user.deleteMany({ where: { id: { in: Object.values(people) } } });
  await db.$disconnect();
});

let made = 0;
const create = (home: ArtifactHome, author: ArtifactActor, kind = "markdown") =>
  artifacts.create({
    workspaceId,
    home,
    name: `doc-${(made += 1)}-${handle}`,
    kind,
    entryPath: "document.md",
    author,
  });
const push = (artifactId: string, publisher: ArtifactActor, sha256 = "sha-doc", baseVersion = 0) =>
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

test("with the experiment off, nothing is created, saved or read", async () => {
  const artifact = await create(inConversation(publicChannel), { userId: people.alice });
  switchedOn = false;
  try {
    const off = { code: "ACCESS_DENIED", errorId: "artifacts-disabled" };
    await expect(create({ kind: "workspace" }, { userId: people.alice })).rejects.toMatchObject(
      off,
    );
    await expect(push(artifact.id, { userId: people.alice })).rejects.toMatchObject(off);
    await expect(read(artifact.id, { userId: people.alice })).rejects.toMatchObject(off);
  } finally {
    switchedOn = true;
  }
});

test("a public channel's artifact: every member reads, only its active members save", async () => {
  const artifact = await create(inConversation(publicChannel), { userId: people.alice });
  expect((await push(artifact.id, { agentId: agents.helper })).status).toBe("created");
  // Bob reads the public channel without being in it, and so reads its artifact, but saves nothing.
  expect((await read(artifact.id, { userId: people.bob })).artifact.id).toBe(artifact.id);
  await expect(push(artifact.id, { userId: people.bob })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  // An Agent of the Workspace reads a public channel too; outside it, it cannot save.
  expect((await read(artifact.id, { agentId: agents.stranger })).artifact.id).toBe(artifact.id);
  await expect(push(artifact.id, { agentId: agents.stranger })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  // Bob cannot make one there either.
  await expect(create(inConversation(publicChannel), { userId: people.bob })).rejects.toMatchObject(
    { code: "ACCESS_DENIED" },
  );
});

test("a private channel's or a DM's artifact is unknown to whoever cannot read them", async () => {
  const closed = await create(inConversation(privateChannel), { agentId: agents.helper });
  const direct = await create(inConversation(dm), { userId: people.bob });
  for (const reader of [
    { userId: people.bob },
    { userId: people.owner },
    { agentId: agents.stranger },
  ] satisfies ArtifactActor[])
    await expect(read(closed.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await read(closed.id, { userId: people.alice })).artifact.id).toBe(closed.id);
  // A Workspace role grants nothing here: the owner is not in the DM.
  await expect(read(direct.id, { userId: people.owner })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await push(direct.id, { userId: people.alice })).status).toBe("created");
  await expect(
    create(inConversation(privateChannel), { userId: people.bob }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a Workspace artifact is every member's to read and save, and nobody else's", async () => {
  const artifact = await create({ kind: "workspace" }, { userId: people.bob });
  expect((await push(artifact.id, { userId: people.alice })).status).toBe("created");
  expect((await push(artifact.id, { agentId: agents.stranger }, "sha-doc-2", 1)).status).toBe(
    "created",
  );
  for (const reader of [{ userId: people.outsider }, { agentId: agents.foreign }])
    await expect(read(artifact.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(create({ kind: "workspace" }, { userId: people.outsider })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a public home is not offered yet, and a conversation must be a channel or a DM here", async () => {
  await expect(create({ kind: "public" }, { userId: people.owner })).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-home",
  });
  await expect(
    create(inConversation(crypto.randomUUID()), { userId: people.alice }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("deleting is the author's or an owner's or admin's; an Agent deletes only its own", async () => {
  const del = (artifactId: string, actor: ArtifactActor) =>
    artifacts.delete({ workspaceId, artifactId, actor });
  const byAlice = await create({ kind: "workspace" }, { userId: people.alice });
  await expect(del(byAlice.id, { userId: people.bob })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(del(byAlice.id, { agentId: agents.helper })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await del(byAlice.id, { userId: people.admin });
  await expect(read(byAlice.id, { userId: people.alice })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  const byAgent = await create({ kind: "workspace" }, { agentId: agents.helper });
  await expect(del(byAgent.id, { agentId: agents.stranger })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await del(byAgent.id, { agentId: agents.helper });
  const row = await db.artifact.findUniqueOrThrow({
    where: { id: byAgent.id },
    select: { deletedAt: true, deletedByAgentId: true },
  });
  expect(row.deletedAt).not.toBeNull();
  expect(row.deletedByAgentId).toBe(agents.helper);
  // An owner or admin deletes only what they can read: a private channel they are not in keeps
  // its artifacts unknown to them, as it keeps its messages.
  const closed = await create(inConversation(privateChannel), { userId: people.alice });
  await expect(del(closed.id, { userId: people.owner })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});

test("a document's own file stays under 2 MiB; other artifacts keep the larger limit", async () => {
  const doc = await create({ kind: "workspace" }, { userId: people.alice });
  await expect(push(doc.id, { userId: people.alice }, "sha-big")).rejects.toMatchObject({
    code: "INVALID_INPUT",
    errorId: "artifact-file-too-large",
  });
  const notes = await create({ kind: "workspace" }, { userId: people.alice }, "text");
  expect((await push(notes.id, { userId: people.alice }, "sha-big")).status).toBe("created");
});

test("leaving a private channel ends access; an archived channel is read only; a hidden one is gone", async () => {
  const closed = await create(inConversation(privateChannel), { userId: people.alice });
  const open = await create(inConversation(publicChannel), { userId: people.alice });
  await db.conversationMember.updateMany({
    where: { conversationId: privateChannel, agentId: agents.helper },
    data: { leftAt: new Date() },
  });
  try {
    await expect(read(closed.id, { agentId: agents.helper })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await db.conversationMember.updateMany({
      where: { conversationId: privateChannel, agentId: agents.helper },
      data: { leftAt: null },
    });
  }

  await db.conversation.update({ where: { id: publicChannel }, data: { archivedAt: new Date() } });
  try {
    expect((await read(open.id, { userId: people.alice })).artifact.id).toBe(open.id);
    await expect(push(open.id, { userId: people.alice })).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
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
  const artifact = await create({ kind: "workspace" }, { userId: people.alice });
  switchedOn = false;
  try {
    const off = { code: "ACCESS_DENIED", errorId: "artifacts-disabled" };
    await expect(
      artifacts.create({
        workspaceId,
        home: { kind: "workspace" },
        name: "Not A Valid Name",
        kind: "markdown",
        entryPath: "document.md",
        author: { userId: people.alice },
      }),
    ).rejects.toMatchObject(off);
    await expect(
      artifacts.delete({ workspaceId, artifactId: artifact.id, actor: { userId: people.alice } }),
    ).rejects.toMatchObject(off);
  } finally {
    switchedOn = true;
  }
});
