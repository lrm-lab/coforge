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
 * An artifact's read tier (task #529): `conversation` keeps it to its home conversation's
 * readers, `workspace` widens it to every Workspace member, people and Agents alike — while
 * writes stay the home's. Its author, the authoring Agent's owner, or a Workspace owner or admin
 * moves the tier; an Agent never may. Every move is recorded in `artifact_access_events`.
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
const people: Record<"owner" | "admin" | "alice" | "bob", string> = {
  owner: "",
  admin: "",
  alice: "",
  bob: "",
};
const agents: Record<"helper" | "stranger", string> = { helper: "", stranger: "" };
let privateChannel: string;
let publicChannel: string;

beforeAll(async () => {
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    const user = await db.user.create({
      data: { username: `at-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: `at-${handle}`,
      name: "Artifact tier",
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
  const agent = (name: string, ownerId: string) =>
    db.agent.create({
      data: {
        workspaceId,
        name: `at-${name}-${handle}`,
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

test("a workspace-shared artifact is every member's read, while writes stay the home's", async () => {
  const change = (artifactId: string, actor: ArtifactActor, access: "conversation" | "workspace") =>
    artifacts.changeAccess({ workspaceId, artifactId, actor, access });
  const shared = await create(inConversation(privateChannel), { userId: people.alice });
  await push(shared.id, { userId: people.alice });
  await expect(read(shared.id, { userId: people.bob })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(read(shared.id, { agentId: agents.stranger })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  // Who may move it: its author, the authoring Agent's owner, or a Workspace owner or admin.
  // Bob cannot read it yet, so his change hears what a missing artifact says.
  await expect(change(shared.id, { userId: people.bob }, "workspace")).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await change(shared.id, { userId: people.alice }, "workspace");
  // The widened read applies at once, people and Agents alike…
  await read(shared.id, { userId: people.bob });
  await read(shared.id, { agentId: agents.stranger });
  // …but a reader who may not change it hears ACCESS_DENIED, and writes stay the home's: Bob
  // reads the artifact, so the home's write answers a refusal, not an absence.
  await expect(change(shared.id, { userId: people.bob }, "conversation")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  await expect(push(shared.id, { userId: people.bob }, "sha-doc", 1)).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });
  // Every write verb answers the same refusal to a tier-only reader — delete, revert, and a
  // document save — and the document's own read reports `canDelete: false` (task #529).
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
  // A tier-only reader sees no homeKey — a private conversation's id is not theirs — nor the
  // write/deletion verbs it cannot use, only the home's kind.
  const widened = await read(shared.id, { userId: people.bob });
  expect(widened.artifact).toMatchObject({
    homeKey: null,
    homeRead: false,
    canWrite: false,
    access: "workspace",
    canChange: false,
    homeKind: "channel",
  });
  // An access change is not a content change: `updatedAt` does not move.
  const before = await db.artifact.findUniqueOrThrow({
    where: { id: shared.id },
    select: { updatedAt: true },
  });
  await change(shared.id, { userId: people.alice }, "conversation");
  await change(shared.id, { userId: people.alice }, "workspace");
  const after = await db.artifact.findUniqueOrThrow({
    where: { id: shared.id },
    select: { updatedAt: true },
  });
  expect(after.updatedAt).toEqual(before.updatedAt);
  // An admin moves it back; the widened readers are out again.
  await change(shared.id, { userId: people.admin }, "conversation");
  await expect(read(shared.id, { userId: people.bob })).rejects.toMatchObject({
    code: "NOT_FOUND",
  });

  // Every change is recorded: which tier it left, which it took, and who moved it.
  const events = await db.artifactAccessEvent.findMany({
    where: { artifactId: shared.id },
    orderBy: { createdAt: "asc" },
  });
  expect(events.map((event) => [event.from, event.to])).toEqual([
    ["conversation", "workspace"],
    ["workspace", "conversation"],
    ["conversation", "workspace"],
    ["workspace", "conversation"],
  ]);
  expect(events[0].actorUserId).toBe(people.alice);
  expect(events[3].actorUserId).toBe(people.admin);

  // A workspace-home artifact has only the workspace tier.
  const workspaceHome = await create({ kind: "workspace" }, { userId: people.alice });
  await expect(
    change(workspaceHome.id, { userId: people.alice }, "conversation"),
  ).rejects.toMatchObject({ code: "INVALID_INPUT", errorId: "artifact-access-tier" });
  // A missing or deleted artifact answers the same NOT_FOUND.
  await expect(
    change(crypto.randomUUID(), { userId: people.alice }, "workspace"),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("concurrent changes serialize under the row lock — no stale-read decisions", async () => {
  const shared = await create(inConversation(publicChannel), { userId: people.alice });
  const change = (actor: ArtifactActor, access: "conversation" | "workspace") =>
    artifacts.changeAccess({ workspaceId, artifactId: shared.id, actor, access });
  // Alice authored it; an admin may change it too — and both read a public channel, so the lock
  // order is the only thing the outcome depends on.
  await Promise.all([
    change({ userId: people.alice }, "workspace"),
    change({ userId: people.admin }, "conversation"),
  ]);
  let row = await db.artifact.findUniqueOrThrow({
    where: { id: shared.id },
    select: { access: true },
  });
  let events = await db.artifactAccessEvent.findMany({
    where: { artifactId: shared.id },
    orderBy: { id: "asc" },
  });
  // Whichever lands second decides; the row must equal the last recorded `to`, and every event
  // must start where the one before left off — nothing is decided on a stale read.
  expect(events).toHaveLength(2);
  expect(events[0].from).toBe("conversation");
  expect(events[1].from).toBe(events[0].to);
  expect(row.access).toBe(events[1].to);

  // Two racing changes to the same tier: one wins the lock, the other reads the new value and
  // returns early — one event, not two.
  const same = await create(inConversation(publicChannel), { userId: people.alice });
  const changeSame = (actor: ArtifactActor) =>
    artifacts.changeAccess({ workspaceId, artifactId: same.id, actor, access: "workspace" });
  await Promise.all([changeSame({ userId: people.alice }), changeSame({ userId: people.admin })]);
  row = await db.artifact.findUniqueOrThrow({
    where: { id: same.id },
    select: { access: true },
  });
  events = await db.artifactAccessEvent.findMany({
    where: { artifactId: same.id },
    orderBy: { id: "asc" },
  });
  expect(row.access).toBe("workspace");
  expect(events).toHaveLength(1);
  expect(events[0].to).toBe("workspace");
});

test("list and cards carry access and canChange; a tier-only reader's card hides the home", async () => {
  const shared = await create(inConversation(privateChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  await artifacts.changeAccess({
    workspaceId,
    artifactId: shared.id,
    actor: { userId: people.alice },
    access: "workspace",
  });

  // Alice sees the card with the home, and may move the tier back (she owns the Agent).
  const aliceCards = await artifacts.reads.cards({
    workspaceId,
    reader: { userId: people.alice },
    artifactIds: [shared.id],
  });
  expect(aliceCards[0]).toMatchObject({
    homeKey: `conversation:${privateChannel}`,
    access: "workspace",
    canChange: true,
  });
  // The admin's card says the same; a member's card hides the home and says it cannot change.
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
  expect(bobCards[0]).toMatchObject({ homeKey: null, access: "workspace", canChange: false });
  // The home's own list still shows only its readers — the tier never widens a listing.
  const listed = await artifacts.reads.list({
    workspaceId,
    reader: { agentId: agents.helper },
    conversationId: privateChannel,
  });
  expect(listed.map((row) => row.id)).toContain(shared.id);

  // A tier-only reader may page its history too.
  const history = await artifacts.reads.history({
    workspaceId,
    artifactId: shared.id,
    reader: { userId: people.bob },
  });
  expect(history.versions.map((version) => version.number)).toContain(1);
});

test("the backfill moves only workspace-home rows to the workspace tier", async () => {
  const wsHome = await create({ kind: "workspace" }, { userId: people.alice });
  const convHome = await create(inConversation(privateChannel), { userId: people.alice });
  // Rows as they stood before the backfill: the column had defaulted `conversation` everywhere.
  await db.$executeRaw`UPDATE "artifacts" SET "access" = 'conversation'
    WHERE "id" IN (${wsHome.id}::uuid, ${convHome.id}::uuid)`;
  // The migration's own UPDATE, replayed.
  await db.$executeRaw`UPDATE "artifacts" SET "access" = 'workspace'
    WHERE "homeKey" = 'workspace' AND "access" IS DISTINCT FROM 'workspace'`;
  const rows = await db.artifact.findMany({
    where: { id: { in: [wsHome.id, convHome.id] } },
    select: { id: true, access: true },
  });
  expect(Object.fromEntries(rows.map((row) => [row.id, row.access]))).toEqual({
    [wsHome.id]: "workspace",
    [convHome.id]: "conversation",
  });
});

test("an Agent's artifact answers canChange to its owner and admins, never to the Agent", async () => {
  const shared = await create(inConversation(publicChannel), { agentId: agents.helper });
  await push(shared.id, { agentId: agents.helper });
  const change = (actor: ArtifactActor, access: "conversation" | "workspace") =>
    artifacts.changeAccess({ workspaceId, artifactId: shared.id, actor, access });

  const byAuthor = await read(shared.id, { agentId: agents.helper });
  expect(byAuthor.artifact.access).toBe("conversation");
  expect(byAuthor.artifact.canChange).toBe(false);
  await expect(change({ agentId: agents.helper }, "workspace")).rejects.toMatchObject({
    code: "ACCESS_DENIED",
  });

  const byMember = await read(shared.id, { userId: people.bob });
  expect(byMember.artifact.canChange).toBe(false);
  // Alice owns the authoring Agent: she may move it even as a plain member.
  const byOwner = await read(shared.id, { userId: people.alice });
  expect(byOwner.artifact.canChange).toBe(true);
  await change({ userId: people.alice }, "workspace");
  const event = await db.artifactAccessEvent.findFirstOrThrow({
    where: { artifactId: shared.id },
  });
  expect(event.actorUserId).toBe(people.alice);
});
