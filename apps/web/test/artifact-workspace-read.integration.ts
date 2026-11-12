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
} from "#src/server/artifacts/artifacts.server";

/**
 * An artifact's read rule (task #20): every Workspace member — people and Agents alike — reads
 * every artifact, including one whose home they cannot read; `homeRead`/`homeKey` keep that
 * home's identity from them, and a message card's `source` falls back to the author. Writes
 * stay the home's. The public link is the one widening beside it, managed by the author, the
 * authoring Agent's owner, or a Workspace owner or admin — never an Agent.
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
  upload: async () => {
    throw new Error("no bytes are stored in this test");
  },
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
      data: { username: `wr-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: `wr-${handle}`,
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
        name: `wr-${name}-${handle}`,
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

test("every member reads every artifact; the home still decides writes and hides itself", async () => {
  const shared = await create(inConversation(privateChannel), { userId: people.alice });
  await push(shared.id, { userId: people.alice });

  // Bob is a member who cannot read the private channel: he reads the artifact, but the home's
  // key, its write verbs and its delete stay his refusals — and the read carries no tier.
  const widened = await read(shared.id, { userId: people.bob });
  expect(widened.artifact).toMatchObject({
    homeKey: null,
    homeRead: false,
    canWrite: false,
    // Not even the home's kind leaks: it reads as the Workspace's own (task #20).
    homeKind: "workspace",
    canChange: false,
  });
  expect("access" in widened.artifact).toBe(false);
  await read(shared.id, { agentId: agents.stranger });
  await expect(read(shared.id, { userId: people.outsider })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  // Alice, the channel's member, keeps the home: its key, the write, and a canDelete read.
  const home = await read(shared.id, { userId: people.alice });
  expect(home.artifact).toMatchObject({
    homeKey: `conversation:${privateChannel}`,
    homeRead: true,
    canWrite: true,
    canChange: true,
  });

  // Writes never follow the read: Bob hears ACCESS_DENIED on every verb, as if he knew it was
  // there — which he does — while the outsider hears NOT_FOUND everywhere.
  await expect(push(shared.id, { userId: people.bob }, "sha-doc", 1)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(
    artifacts.delete({ workspaceId, artifactId: shared.id, actor: { userId: people.bob } }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    artifacts.revert({
      workspaceId,
      artifactId: shared.id,
      actor: { userId: people.bob },
      to: 1,
      baseVersion: 1,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  await expect(
    documents.save(
      { workspaceId, actor: { userId: people.bob } },
      {
        artifactId: shared.id,
        baseVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        text: "changed",
      },
    ),
  ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  const loaded = await documents.load(
    { workspaceId, actor: { userId: people.bob } },
    { artifactId: shared.id },
  );
  expect(loaded.canDelete).toBe(false);
  expect(loaded.artifact.homeKey).toBeNull();
  await expect(
    documents.save(
      { workspaceId, actor: { userId: people.outsider } },
      {
        artifactId: shared.id,
        baseVersion: 1,
        idempotencyKey: crypto.randomUUID(),
        text: "changed",
      },
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });

  // History and cards open to the member too; the card hides the home and says no link change.
  const history = await artifacts.reads.history({
    workspaceId,
    artifactId: shared.id,
    reader: { userId: people.bob },
  });
  expect(history.versions.map((version) => version.number)).toContain(1);
  const bobCards = await artifacts.reads.cards({
    workspaceId,
    reader: { userId: people.bob },
    artifactIds: [shared.id],
  });
  expect(bobCards[0]).toMatchObject({ homeKey: null, canChange: false });
  expect("access" in bobCards[0]!).toBe(false);
  // The home's own list still asks the home's rule: Bob cannot list the private channel's
  // artifacts even though he can read each one by id.
  await expect(
    artifacts.reads.list({
      workspaceId,
      reader: { userId: people.bob },
      conversationId: privateChannel,
    }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const listed = await artifacts.reads.list({
    workspaceId,
    reader: { agentId: agents.helper },
    conversationId: privateChannel,
  });
  expect(listed.map((row) => row.id)).toContain(shared.id);
});

test("cards and message cards keep the home from a member who cannot read it", async () => {
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });

  // Alice owns the authoring Agent and reads the home: her card names it and may manage the
  // public link; the admin's card says the same; Bob's hides the home and says no.
  const aliceCards = await artifacts.reads.cards({
    workspaceId,
    reader: { userId: people.alice },
    artifactIds: [shared.id],
  });
  expect(aliceCards[0]).toMatchObject({
    homeKey: `conversation:${privateChannel}`,
    canChange: true,
  });
  const adminCards = await artifacts.reads.cards({
    workspaceId,
    reader: { userId: people.admin },
    artifactIds: [shared.id],
  });
  expect(adminCards[0]).toMatchObject({ canChange: true });
  const bobCards = await artifacts.reads.cards({
    workspaceId,
    reader: { userId: people.bob },
    artifactIds: [shared.id],
  });
  expect(bobCards[0]).toMatchObject({ homeKey: null, canChange: false });
  // An Agent never manages the link, whoever owns it.
  const agentRead = await read(shared.id, { agentId: agents.stranger });
  expect(agentRead.artifact.canChange).toBe(false);

  // A message card opens for the member, but its source names the author — never the private
  // conversation it came from; the home reader's card keeps the conversation.
  const body = `/w/${workspaceSlug}/artifacts/${shared.id}`;
  const [bobCards2] = await artifacts.reads.messageCards({
    workspaceId,
    reader: { userId: people.bob },
    messages: [{ body }],
  });
  expect(bobCards2![0]).toMatchObject({
    state: "open",
    canOpen: true,
    source: { agentId: agents.helper, label: "Agent" },
  });
  expect(bobCards2![0]!.state === "open" && "conversationId" in bobCards2![0]!.source).toBe(false);
  const [aliceCards2] = await artifacts.reads.messageCards({
    workspaceId,
    reader: { userId: people.alice },
    messages: [{ body }],
  });
  expect(aliceCards2![0]).toMatchObject({
    state: "open",
    source: { conversationId: privateChannel },
  });
});

test("a public channel's artifact keeps its home source for every member", async () => {
  const shared = await create(inConversation(publicChannel), { userId: people.alice });
  await push(shared.id, { userId: people.alice });
  const [bobCards] = await artifacts.reads.messageCards({
    workspaceId,
    reader: { userId: people.bob },
    messages: [{ body: `/w/${workspaceSlug}/artifacts/${shared.id}` }],
  });
  // A public channel's readers include every member, so its source is not private.
  expect(bobCards![0]).toMatchObject({
    state: "open",
    source: { conversationId: publicChannel, label: `#open-${handle}` },
  });
});

test("a home the Workspace hides takes its artifacts with it", async () => {
  const shared = await create(inConversation(privateChannel), { userId: people.alice });
  await push(shared.id, { userId: people.alice });
  await db.conversation.update({
    where: { id: privateChannel },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    // Even a member who reads every artifact — the channel's own member included — hears
    // NOT_FOUND, as if it were not there; the card and the message card agree.
    for (const reader of [{ userId: people.bob }, { userId: people.alice }])
      await expect(read(shared.id, reader)).rejects.toMatchObject({ code: "NOT_FOUND" });
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
  } finally {
    await db.conversation.update({
      where: { id: privateChannel },
      data: { hiddenFromWorkspaceAt: null },
    });
  }
});
