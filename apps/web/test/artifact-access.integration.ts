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
import { legacyWorkspaceArtifact } from "./helpers/legacy-workspace-artifact";

/**
 * Who may read, push to and delete an artifact: whoever reads its home conversation, or every
 * member and Agent once it is widened to the Workspace; an artifact nobody can see answers
 * NOT_FOUND. An Agent pushes to any artifact it reads and makes a new one only where it is an
 * active member of an unarchived conversation. Deleting is a Workspace owner's or admin's or the
 * authoring Agent's owner's; an Agent deletes only its own. Nothing works while the Workspace has
 * not switched the `artifacts` experiment on.
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
  artifacts.reads.read({ workspaceId, artifactId, reader });
const createLegacy = (author: ArtifactPublisher) =>
  legacyWorkspaceArtifact(db, {
    workspaceId,
    name: `doc-${(made += 1)}-${handle}`,
    entryPath: "document.md",
    author,
  });
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
    await expect(create(inConversation(publicChannel), helper)).rejects.toMatchObject(off);
    await expect(push(artifact.id, helper)).rejects.toMatchObject(off);
    await expect(read(artifact.id, { userId: people.alice })).rejects.toMatchObject(off);
  } finally {
    switchedOn = true;
  }
});

test("a public channel's artifact: every member reads, and any Agent that reads it pushes", async () => {
  const artifact = await create(inConversation(publicChannel), helper);
  expect((await push(artifact.id, helper)).status).toBe("created");
  expect((await read(artifact.id, { userId: people.bob })).artifact.id).toBe(artifact.id);
  expect((await read(artifact.id, stranger)).artifact.id).toBe(artifact.id);
  expect((await push(artifact.id, stranger, "sha-doc-2", 1)).status).toBe("created");
  await expect(create(inConversation(publicChannel), stranger)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
});

test("a private channel's or a DM's artifact is its active members' alone, and answers NOT_FOUND to the rest", async () => {
  const closed = await create(inConversation(privateChannel), helper);
  const direct = await create(inConversation(agentDm), helper);
  const aliceRead = await read(closed.id, { userId: people.alice });
  expect(aliceRead.artifact).toMatchObject({
    homeKey: `conversation:${privateChannel}`,
    homeKind: "channel",
    access: "conversation",
  });
  expect((await read(closed.id, helper)).artifact.id).toBe(closed.id);
  for (const reader of [
    { userId: people.bob },
    { userId: people.owner },
    { userId: people.admin },
    { agentId: agents.stranger },
    { userId: people.outsider },
    { agentId: agents.foreign },
  ] satisfies ArtifactActor[])
    await expect(read(closed.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(push(closed.id, stranger)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect((await read(direct.id, { userId: people.alice })).artifact.homeKind).toBe("dm");
  await expect(read(direct.id, { userId: people.owner })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await push(direct.id, helper)).status).toBe("created");
  await expect(create(inConversation(privateChannel), stranger)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(create(inConversation(dm), helper)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a widened artifact reads as the Workspace's: every member and Agent reads it and any Agent pushes, nobody outside does", async () => {
  const artifact = await create(inConversation(privateChannel), helper);
  await artifacts.visibility.moveToWorkspace({
    workspaceId,
    artifactId: artifact.id,
    agentId: agents.helper,
  });
  for (const reader of [
    { userId: people.bob },
    { userId: people.owner },
    { agentId: agents.stranger },
  ] satisfies ArtifactActor[]) {
    const { artifact: shown } = await read(artifact.id, reader);
    expect(shown).toMatchObject({
      homeKey: "workspace",
      homeKind: "workspace",
      access: "workspace",
      narrowable: false,
    });
  }
  expect((await read(artifact.id, { userId: people.alice })).artifact.narrowable).toBe(true);
  expect((await read(artifact.id, { agentId: agents.helper })).artifact.narrowable).toBe(false);
  for (const reader of [
    { userId: people.alice },
    { agentId: agents.helper },
  ] satisfies ArtifactActor[])
    expect((await read(artifact.id, reader)).artifact).toMatchObject({
      homeKey: `conversation:${privateChannel}`,
      homeKind: "channel",
      access: "workspace",
    });
  expect((await push(artifact.id, stranger)).status).toBe("created");
  for (const reader of [{ userId: people.outsider }, { agentId: agents.foreign }])
    await expect(read(artifact.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("an artifact of the legacy Workspace home reads workspace-wide", async () => {
  const artifact = await createLegacy(stranger);
  expect((await push(artifact.id, helper)).status).toBe("created");
  expect((await push(artifact.id, stranger, "sha-doc-2", 1)).status).toBe("created");
  expect((await read(artifact.id, { userId: people.bob })).artifact).toMatchObject({
    homeKey: "workspace",
    access: "workspace",
  });
  for (const reader of [{ userId: people.outsider }, { agentId: agents.foreign }])
    await expect(read(artifact.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
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

test("deleting is an owner's or admin's or the authoring Agent's owner's; an Agent deletes only its own", async () => {
  const del = (artifactId: string, actor: ArtifactActor) =>
    artifacts.delete({ workspaceId, artifactId, actor });
  const byHelper = await createLegacy(helper);
  // A member who is neither the Workspace's owner nor admin, and another Agent, may not.
  await expect(del(byHelper.id, { userId: people.bob })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(del(byHelper.id, stranger)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await del(byHelper.id, { userId: people.admin });
  await expect(read(byHelper.id, { userId: people.alice })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  // The authoring Agent's owner deletes its artifact too, though a plain member (task #25);
  // a member who owns no part of it still may not.
  const owned = await createLegacy(helper);
  await expect(del(owned.id, { userId: people.bob })).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await del(owned.id, { userId: people.alice });

  const byStranger = await createLegacy(stranger);
  await del(byStranger.id, stranger);
  const row = await db.artifact.findUniqueOrThrow({
    where: { id: byStranger.id },
    select: { deletedAt: true, deletedByAgentId: true },
  });
  expect(row.deletedAt).not.toBeNull();
  expect(row.deletedByAgentId).toBe(agents.stranger);
  const closed = await create(inConversation(privateChannel), helper);
  await expect(del(closed.id, { userId: people.owner })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await del(closed.id, helper);
  await expect(del(closed.id, helper)).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("leaving a private channel ends the read; an archived channel is read only; a hidden or deleted home leaves the artifact to its author, its author's owner and the admins", async () => {
  const closed = await create(inConversation(privateChannel), helper);
  const open = await create(inConversation(publicChannel), helper);
  await db.conversationMember.updateMany({
    where: { conversationId: privateChannel, agentId: agents.helper },
    data: { leftAt: new Date() },
  });
  try {
    await expect(read(closed.id, { agentId: agents.helper })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(push(closed.id, { agentId: agents.helper })).rejects.toMatchObject({
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
    expect((await push(open.id, helper)).status).toBe("created");
    await expect(create(inConversation(publicChannel), helper)).rejects.toMatchObject({
      code: "ACCESS_DENIED",
    });
  } finally {
    await db.conversation.update({ where: { id: publicChannel }, data: { archivedAt: null } });
  }

  const reachable = [
    { agentId: agents.helper },
    { userId: people.alice },
    { userId: people.admin },
    { userId: people.owner },
  ] satisfies ArtifactActor[];
  const unreachable = [
    { agentId: agents.stranger },
    { userId: people.bob },
    { userId: people.outsider },
  ] satisfies ArtifactActor[];
  await db.conversation.update({
    where: { id: publicChannel },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    for (const reader of reachable) expect((await read(open.id, reader)).artifact.id).toBe(open.id);
    for (const reader of unreachable)
      await expect(read(open.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await push(open.id, helper, "sha-doc-2", 1)).status).toBe("created");
    await expect(push(open.id, stranger, "sha-doc", 2)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await db.conversation.update({
      where: { id: publicChannel },
      data: { hiddenFromWorkspaceAt: null },
    });
  }

  const gone = await db.conversation.create({
    data: { workspaceId, channelName: `gone-${handle}`, visibility: "public" },
  });
  await db.conversationMember.create({
    data: { conversationId: gone.id, workspaceId, agentId: agents.helper },
  });
  const orphan = await create(inConversation(gone.id), helper);
  await db.conversationMember.deleteMany({ where: { conversationId: gone.id } });
  await db.conversation.delete({ where: { id: gone.id } });
  for (const reader of reachable)
    expect((await read(orphan.id, reader)).artifact.id).toBe(orphan.id);
  for (const reader of unreachable)
    await expect(read(orphan.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const asOwner = await read(orphan.id, { userId: people.alice });
  expect(asOwner.artifact).toMatchObject({ homeKey: null, homeKind: "workspace" });
});

test("a list with no home names every artifact the reader can see, and a list of a home that home's", async () => {
  const closed = await create(inConversation(privateChannel), helper);
  const open = await create(inConversation(publicChannel), helper);
  const legacy = await createLegacy(helper);
  const wide = await create(inConversation(privateChannel), helper);
  await artifacts.visibility.moveToWorkspace({
    workspaceId,
    artifactId: wide.id,
    agentId: agents.helper,
  });
  const ids = async (reader: ArtifactActor, conversationId?: string) =>
    (await artifacts.reads.list({ workspaceId, reader, conversationId })).map((row) => row.id);
  const bobSees = await ids({ userId: people.bob });
  expect(bobSees).toEqual(expect.arrayContaining([open.id, legacy.id, wide.id]));
  expect(bobSees).not.toContain(closed.id);
  expect(await ids({ userId: people.alice })).toEqual(
    expect.arrayContaining([open.id, legacy.id, wide.id, closed.id]),
  );
  expect(await ids({ agentId: agents.stranger })).not.toContain(closed.id);
  expect(await ids({ userId: people.alice }, privateChannel)).toEqual(
    expect.arrayContaining([closed.id, wide.id]),
  );
  await expect(ids({ userId: people.bob }, privateChannel)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(ids({ userId: people.outsider })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("with the experiment off, a bad request and a delete hear only that it is off", async () => {
  const artifact = await createLegacy(helper);
  switchedOn = false;
  try {
    const off = { code: "ACCESS_DENIED", errorId: "artifacts-disabled" };
    await expect(
      artifacts.create({
        workspaceId,
        home: inConversation(publicChannel),
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
