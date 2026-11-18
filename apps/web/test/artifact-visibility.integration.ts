import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  conversationRealtimeChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";
import { legacyWorkspaceArtifact } from "./helpers/legacy-workspace-artifact";
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

test("widening tells the home's pages and the Workspace's, narrowing only the home's", async () => {
  const published: string[] = [];
  const signalled = new Artifacts(db, store, {
    enabled: async () => true,
    signals: { publish: async (channel) => void published.push(channel) },
  });
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  const home = conversationRealtimeChannel(privateChannel);
  const everyone = workspaceConversationChannel(workspaceId);

  await signalled.visibility.moveToWorkspace({
    workspaceId,
    artifactId: shared.id,
    agentId: agents.helper,
  });
  expect(published).toEqual([home, everyone]);

  published.length = 0;
  await signalled.visibility.change({
    workspaceId,
    artifactId: shared.id,
    userId: people.alice,
    tier: "conversation",
  });
  expect(published).toEqual([home]);

  published.length = 0;
  await signalled.visibility.change({
    workspaceId,
    artifactId: shared.id,
    userId: people.alice,
    tier: "workspace",
  });
  expect(published).toEqual([home, everyone]);
});

test("a list with no home shows exactly what a read of each artifact allows, in one pass of the database", async () => {
  const counted: string[] = [];
  const countingDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: [{ emit: "event", level: "query" }],
  });
  countingDb.$on("query", (event) => counted.push(event.query));
  const listing = new Artifacts(countingDb, store, { enabled: async () => true });
  try {
    const helper = { agentId: agents.helper };
    const seat = async (
      conversationId: string,
      members: ({ userId: string } | { agentId: string })[],
    ) =>
      db.conversationMember.createMany({
        data: members.map((member) => ({ conversationId, workspaceId, ...member })),
      });
    const dm = (
      await db.conversation.create({
        data: { workspaceId, directKey: `user:${people.alice}|user:${people.bob}-${handle}` },
      })
    ).id;
    await seat(dm, [{ userId: people.alice }, { userId: people.bob }, helper]);
    const hiddenChannel = (
      await db.conversation.create({
        data: {
          workspaceId,
          channelName: `hidden-${handle}`,
          visibility: "public",
        },
      })
    ).id;
    await seat(hiddenChannel, [helper]);
    const goneChannel = (
      await db.conversation.create({
        data: { workspaceId, channelName: `gone-${handle}`, visibility: "public" },
      })
    ).id;
    await seat(goneChannel, [helper]);
    const made = [
      await create(inConversation(privateChannel), helper),
      await create(inConversation(publicChannel), helper),
      await create(inConversation(dm), helper),
      await create(inConversation(hiddenChannel), helper),
      await create(inConversation(goneChannel), helper),
      await legacyWorkspaceArtifact(db, {
        workspaceId,
        name: `legacy-${handle}`,
        entryPath: "document.md",
        author: helper,
      }),
    ];
    const wide = await create(inConversation(privateChannel), helper);
    await db.artifact.update({ where: { id: wide.id }, data: { access: "workspace" } });
    made.push(wide);
    await db.conversation.update({
      where: { id: hiddenChannel },
      data: { hiddenFromWorkspaceAt: new Date() },
    });
    await db.conversationMember.deleteMany({ where: { conversationId: goneChannel } });
    await db.conversation.delete({ where: { id: goneChannel } });

    const readers: ArtifactActor[] = [
      { userId: people.owner },
      { userId: people.admin },
      { userId: people.alice },
      { userId: people.bob },
      { agentId: agents.helper },
      { agentId: agents.stranger },
    ];
    const mine = new Set(made.map((artifact) => artifact.id));
    for (const reader of readers) {
      counted.length = 0;
      const listed = (await listing.reads.list({ workspaceId, reader })).map((row) => row.id);
      const queriesOfList = counted.length;
      const allowed = (
        await Promise.all(
          made.map(async ({ id }) =>
            (await read(id, reader).then(
              () => true,
              () => false,
            ))
              ? [id]
              : [],
          ),
        )
      ).flat();
      expect(listed.filter((id) => mine.has(id)).sort()).toEqual(allowed.sort());
      expect(queriesOfList).toBe(4);
    }
    expect(counted.some((query) => /FROM "public"\."conversations"/.test(query))).toBe(false);
  } finally {
    await countingDb.$disconnect();
  }
});

test("an owner opens an artifact to anyone with the link; members still read it, and narrowing it ends the old public links", async () => {
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  const change = (tier: "conversation" | "workspace" | "link", userId = people.alice) =>
    artifacts.visibility.change({
      workspaceId,
      artifactId: shared.id,
      userId,
      tier,
    });
  const events = () =>
    db.artifactAccessEvent.findMany({
      where: { artifactId: shared.id },
      orderBy: { createdAt: "asc" },
      select: { from: true, to: true, actorUserId: true },
    });

  expect(await change("link")).toMatchObject({ from: "conversation", to: "link" });
  expect((await db.artifact.findUniqueOrThrow({ where: { id: shared.id } })).access).toBe("link");
  expect((await read(shared.id, { userId: people.bob })).artifact.access).toBe("workspace");
  expect(await change("link")).toMatchObject({ from: "link", to: "link" });
  expect(await events()).toEqual([{ from: "conversation", to: "link", actorUserId: people.alice }]);
  await expect(change("link", people.bob)).rejects.toMatchObject({ code: "ACCESS_DENIED" });

  const token = `tok-${crypto.randomUUID()}`;
  await db.artifactPublicLink.create({
    data: { artifactId: shared.id, token, createdByUserId: people.alice },
  });
  expect(await change("workspace")).toMatchObject({ from: "link", to: "workspace" });
  expect(
    (await db.artifactPublicLink.findFirstOrThrow({ where: { token } })).revokedAt,
  ).not.toBeNull();
  expect((await events()).at(-1)).toEqual({
    from: "link",
    to: "workspace",
    actorUserId: people.alice,
  });

  await change("link");
  const second = `tok-${crypto.randomUUID()}`;
  await db.artifactPublicLink.create({
    data: { artifactId: shared.id, token: second, createdByUserId: people.alice },
  });
  expect(await change("conversation")).toMatchObject({ from: "link", to: "conversation" });
  expect(
    (await db.artifactPublicLink.findFirstOrThrow({ where: { token: second } })).revokedAt,
  ).not.toBeNull();
});

test("an Agent cannot move a link-tier artifact, and setting link is a person's alone", async () => {
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  await artifacts.visibility.change({
    workspaceId,
    artifactId: shared.id,
    userId: people.alice,
    tier: "link",
  });
  await expect(
    artifacts.visibility.moveToWorkspace({
      workspaceId,
      artifactId: shared.id,
      agentId: agents.helper,
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
