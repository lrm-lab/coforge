import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ArtifactDocuments } from "#src/server/artifacts/artifact-documents.server";
import {
  Artifacts,
  type ArtifactActor,
  type ArtifactBlobInfo,
  type ArtifactBlobStore,
  type ArtifactHome,
  type ArtifactPublisher,
} from "#src/server/artifacts/artifacts.server";

/**
 * Who sees an artifact: its home conversation's readers, or everyone once it is widened to the
 * Workspace. The read, the cards and the message cards agree, and the sharing controls belong to
 * the author's owner and the Workspace's owners and admins.
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
const artifacts = new Artifacts(db, store, { enabled: async () => true });
const documents = new ArtifactDocuments(db, artifacts, store);

let workspaceId: string;
let workspaceSlug: string;
const people: Record<"owner" | "admin" | "alice" | "bob" | "outsider", string> = {
  owner: "",
  admin: "",
  alice: "",
  bob: "",
  outsider: "",
};
const agents: Record<"helper" | "stranger", string> = { helper: "", stranger: "" };
let privateChannel: string;
let publicChannel: string;

beforeAll(async () => {
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    const user = await db.user.create({
      data: { username: `vis-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: `vis-${handle}`,
      name: "Artifact read",
      members: {
        create: [
          { userId: people.owner, role: "owner" },
          { userId: people.admin, role: "admin" },
          { userId: people.alice, role: "member" },
          { userId: people.bob, role: "member" },
          // `outsider` is a user with no membership: the Workspace's artifacts are not theirs.
        ],
      },
    },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;
  const agent = (name: string, ownerId: string) =>
    db.agent.create({
      data: {
        workspaceId,
        name: `vis-${name}-${handle}`,
        displayName: name,
        ownerId,
        runtimeConfig: {},
      },
    });
  agents.helper = (await agent("helper", people.alice)).id;
  agents.stranger = (await agent("stranger", people.alice)).id;

  const { id } = await db.conversation.create({
    data: { workspaceId, channelName: `closed-${handle}`, visibility: "private" },
  });
  privateChannel = id;
  await db.conversationMember.createMany({
    data: [
      { conversationId: id, workspaceId, userId: people.alice },
      { conversationId: id, workspaceId, agentId: agents.helper },
    ],
  });
  const pub = await db.conversation.create({
    data: { workspaceId, channelName: `open-${handle}`, visibility: "public" },
  });
  publicChannel = pub.id;
  await db.conversationMember.createMany({
    data: [
      { conversationId: pub.id, workspaceId, userId: people.alice },
      { conversationId: pub.id, workspaceId, agentId: agents.helper },
    ],
  });
  blobs.set("sha-doc", { kind: "text", sizeBytes: 100 });
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: workspaceId } });
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
const inConversation = (conversationId: string): ArtifactHome => ({
  kind: "conversation",
  conversationId,
});

test("a conversation artifact is seen by that conversation's readers and its card carries the home", async () => {
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  const aliceRead = await read(shared.id, { userId: people.alice });
  expect(aliceRead.artifact).toMatchObject({
    homeKey: `conversation:${privateChannel}`,
    homeKind: "channel",
    access: "conversation",
    canChange: true,
  });
  for (const reader of [
    { userId: people.bob },
    { userId: people.admin },
    { agentId: agents.stranger },
    { userId: people.outsider },
  ])
    await expect(read(shared.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const cards = async (reader: ArtifactActor) =>
    artifacts.reads.cards({ workspaceId, reader, artifactIds: [shared.id] });
  expect(await cards({ userId: people.bob })).toEqual([]);
  expect((await cards({ userId: people.alice }))[0]).toMatchObject({
    homeKey: `conversation:${privateChannel}`,
    access: "conversation",
  });
  const body = `/w/${workspaceSlug}/artifacts/${shared.id}`;
  const messageCard = async (reader: ArtifactActor) =>
    (await artifacts.reads.messageCards({ workspaceId, reader, messages: [{ body }] }))[0]![0];
  expect(await messageCard({ userId: people.bob })).toMatchObject({
    state: "forbidden",
    canOpen: false,
  });
  expect(await messageCard({ userId: people.alice })).toMatchObject({
    state: "open",
    source: { conversationId: privateChannel },
  });
  const listed = await artifacts.reads.list({
    workspaceId,
    reader: { agentId: agents.helper },
    conversationId: privateChannel,
  });
  expect(listed.map((row) => row.id)).toContain(shared.id);
  await expect(
    artifacts.reads.list({
      workspaceId,
      reader: { userId: people.bob },
      conversationId: privateChannel,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("a widened artifact is every member's, with the Workspace as its source; only owners of it manage sharing", async () => {
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  await db.artifact.update({ where: { id: shared.id }, data: { access: "workspace" } });
  const bob = await read(shared.id, { userId: people.bob });
  expect(bob.artifact).toMatchObject({
    homeKey: "workspace",
    homeKind: "workspace",
    access: "workspace",
    canChange: false,
  });
  expect((await read(shared.id, { userId: people.alice })).artifact.canChange).toBe(true);
  expect((await read(shared.id, { userId: people.admin })).artifact.canChange).toBe(true);
  expect((await read(shared.id, { agentId: agents.stranger })).artifact.canChange).toBe(false);
  await expect(read(shared.id, { userId: people.outsider })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  const [cards] = await artifacts.reads.messageCards({
    workspaceId,
    reader: { userId: people.bob },
    messages: [{ body: `/w/${workspaceSlug}/artifacts/${shared.id}` }],
  });
  expect(cards![0]).toMatchObject({
    state: "open",
    canOpen: true,
    source: { agentId: agents.helper },
  });
  expect(cards![0]!.state === "open" && "conversationId" in cards![0]!.source).toBe(false);
  const loaded = await documents.load(
    { workspaceId, actor: { userId: people.bob } },
    { artifactId: shared.id },
  );
  expect(loaded.canDelete).toBe(false);
  await expect(
    artifacts.delete({ workspaceId, artifactId: shared.id, actor: { userId: people.bob } }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
});

test("a public channel's artifact keeps its home source for every member", async () => {
  const shared = await create(inConversation(publicChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  const [bobCards] = await artifacts.reads.messageCards({
    workspaceId,
    reader: { userId: people.bob },
    messages: [{ body: `/w/${workspaceSlug}/artifacts/${shared.id}` }],
  });
  expect(bobCards![0]).toMatchObject({
    state: "open",
    source: { conversationId: publicChannel, label: `#open-${handle}` },
  });
});

test("a hidden home leaves its artifact to the author, the author's owner and the admins, and a widened one stays everyone's", async () => {
  const shared = await create(inConversation(publicChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  const wide = await create(inConversation(publicChannel), { agentId: agents.helper });
  await push(wide.id, { agentId: agents.helper });
  await db.artifact.update({ where: { id: wide.id }, data: { access: "workspace" } });
  await db.conversation.update({
    where: { id: publicChannel },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    await expect(read(shared.id, { userId: people.bob })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await artifacts.reads.cards({
        workspaceId,
        reader: { userId: people.bob },
        artifactIds: [shared.id],
      }),
    ).toEqual([]);
    const [cards] = await artifacts.reads.messageCards({
      workspaceId,
      reader: { userId: people.bob },
      messages: [{ body: `/w/${workspaceSlug}/artifacts/${shared.id}` }],
    });
    expect(cards![0]).toMatchObject({ state: "forbidden", canOpen: false });
    for (const reader of [
      { agentId: agents.helper },
      { userId: people.alice },
      { userId: people.admin },
      { userId: people.owner },
    ])
      expect((await read(shared.id, reader)).artifact.id).toBe(shared.id);
    expect((await read(wide.id, { userId: people.bob })).artifact.id).toBe(wide.id);
  } finally {
    await db.conversation.update({
      where: { id: publicChannel },
      data: { hiddenFromWorkspaceAt: null },
    });
  }
});
