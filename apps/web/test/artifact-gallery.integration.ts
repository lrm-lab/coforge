import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { artifactTier } from "#src/server/artifacts/artifact-access.server";
import { ArtifactGallery } from "#src/server/artifacts/artifact-gallery.server";
import { ArtifactViewerPositions } from "#src/server/artifacts/artifact-viewer-positions.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";

let f: CommentsFixture;
let gallery: ArtifactGallery;
let positions: ArtifactViewerPositions;
let last = 0;
const now = () => new Date((last = Math.max(Date.now(), last + 1)));
const ids: Record<string, string> = {};
let docsId: string;

beforeAll(async () => {
  f = await commentsFixture("gl");
  gallery = new ArtifactGallery(f.db, async () => true, f.artifacts.reads);
  positions = new ArtifactViewerPositions(f.db, f.artifacts.reads, now);
  docsId = (
    await f.db.conversation.findFirstOrThrow({
      where: { workspaceId: f.workspaceId, channelName: f.docsChannel },
    })
  ).id;
  ids.alpha = await f.make("Alpha plan");
  ids.beta = await f.make("Beta notes");
  ids.gamma = await f.make("Gamma secret", undefined, { target: `#${f.privateChannel}` });
  ids.delta = await f.make("Delta report", undefined, { by: f.agents.other });
  await f.db.artifact.update({ where: { id: ids.delta }, data: { access: "workspace" } });
  await f.db.artifactPublicLink.create({
    data: { artifactId: ids.beta!, token: `tok-${crypto.randomUUID()}`, createdByUserId: f.alice },
  });
});
afterAll(() => f.cleanup());

const page = (userId: string, extra: Partial<Parameters<ArtifactGallery["page"]>[0]> = {}) =>
  gallery.page({ workspaceId: f.workspaceId, userId, sort: "updated", limit: 20, ...extra });
const titles = async (userId: string, extra = {}) =>
  (await page(userId, extra)).artifacts.map((card) => card.title).sort();

test("a person sees only the artifacts they may read", async () => {
  expect(await titles(f.alice)).toEqual([
    "Alpha plan",
    "Beta notes",
    "Delta report",
    "Gamma secret",
  ]);
  expect(await titles(f.bob)).toEqual(["Alpha plan", "Beta notes", "Delta report"]);
});

test("a title search needs every word, in any case", async () => {
  expect(await titles(f.alice, { query: "plan alpha" })).toEqual(["Alpha plan"]);
  expect(await titles(f.alice, { query: "%" })).toEqual([]);
});

test("the conversation filter has two pseudo-scopes", async () => {
  expect(
    await titles(f.alice, { scope: { kind: "conversation", conversationId: docsId } }),
  ).toEqual(["Alpha plan", "Beta notes", "Delta report"]);
  expect(await titles(f.alice, { scope: { kind: "workspace" } })).toEqual(["Delta report"]);
  expect(await titles(f.alice, { scope: { kind: "link" } })).toEqual(["Beta notes"]);
  await expect(
    page(f.bob, { scope: { kind: "conversation", conversationId: await privateId() } }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

const privateId = async () =>
  (
    await f.db.conversation.findFirstOrThrow({
      where: { workspaceId: f.workspaceId, channelName: f.privateChannel },
    })
  ).id;

test("the author filter names Agents", async () => {
  expect(await titles(f.alice, { authorAgentIds: [f.agents.other] })).toEqual(["Delta report"]);
  expect(await titles(f.alice, { authorAgentIds: [f.agents.other, f.agents.reader] })).toEqual([
    "Delta report",
  ]);
});

test("the cards carry visibility, version, author and counts", async () => {
  const cards = (await page(f.bob)).artifacts;
  const beta = cards.find((card) => card.id === ids.beta)!;
  expect(beta).toMatchObject({
    access: "conversation",
    link: true,
    currentVersion: 1,
    author: { agentId: f.agents.writer },
    openedAt: null,
    commentCount: 0,
    hasUpdates: false,
    newComments: 0,
    mentionsYou: false,
  });
  expect(cards.find((card) => card.id === ids.delta)).toMatchObject({
    access: "workspace",
    homeKey: "workspace",
    link: false,
  });
});

test("recently opened puts what the person opened first, newest first, never-opened last", async () => {
  await positions.open({ workspaceId: f.workspaceId, artifactId: ids.alpha!, userId: f.bob });
  await positions.open({ workspaceId: f.workspaceId, artifactId: ids.delta!, userId: f.bob });
  const opened = await page(f.bob, { sort: "opened" });
  expect(opened.artifacts.map((card) => card.title)).toEqual([
    "Delta report",
    "Alpha plan",
    "Beta notes",
  ]);
  expect(opened.artifacts[0]!.openedAt).toBeInstanceOf(Date);
  expect(opened.artifacts[2]!.openedAt).toBeNull();
});

test("opening an artifact answers with the roster that already lists the opener", async () => {
  const roster = await positions.open({
    workspaceId: f.workspaceId,
    artifactId: ids.alpha!,
    userId: f.alice,
  });
  expect(roster.you).toBe(f.alice);
  expect(roster.seen.map((person) => person.userId)).toContain(f.alice);
});

test("a page is stable and a cursor continues it, in both sorts", async () => {
  for (const sort of ["opened", "updated"] as const) {
    const first = await page(f.bob, { sort, limit: 2 });
    expect(first.artifacts).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    const second = await page(f.bob, { sort, limit: 2, cursor: first.nextCursor });
    expect(second.artifacts).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const all = await page(f.bob, { sort, limit: 10 });
    expect([...first.artifacts, ...second.artifacts].map((card) => card.id)).toEqual(
      all.artifacts.map((card) => card.id),
    );
  }
  await expect(page(f.bob, { cursor: "nonsense" })).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
});

test("related to me: my Agents' artifacts, those I commented on, follow or was mentioned in (a mention follows), not a near-miss handle", async () => {
  expect(await titles(f.alice, { related: true })).toEqual([
    "Alpha plan",
    "Beta notes",
    "Delta report",
    "Gamma secret",
  ]);
  expect(await titles(f.bob, { related: true })).toEqual([]);
  await f.personComments(ids.alpha!, f.bob, { body: "looks good" });
  await f.db.artifactFollow.create({
    data: { artifactId: ids.beta!, userId: f.bob, following: true },
  });
  const mentioned = await f.db.user.findUniqueOrThrow({ where: { id: f.bob } });
  await f.post(f.agents.writer, {
    operation: "comment",
    artifact: ids.delta,
    body: `ping @${mentioned.username} please look`,
    idempotencyKey: f.key(),
  });
  const quiet = await f.make("Zeta quiet");
  await f.post(f.agents.writer, {
    operation: "comment",
    artifact: quiet,
    body: `not @${mentioned.username}x at all`,
    idempotencyKey: f.key(),
  });
  expect(await titles(f.bob, { related: true })).toEqual([
    "Alpha plan",
    "Beta notes",
    "Delta report",
  ]);
});

test("badges: updates since the last open, new comments by others, mentions", async () => {
  const bobCards = async () =>
    new Map((await page(f.bob)).artifacts.map((card) => [card.id, card]));
  await Bun.sleep(5);
  await f.post(f.agents.writer, { operation: "comments", artifact: ids.alpha });
  await f.pushText(ids.alpha!, f.agents.writer, "newer\n");
  await f.personComments(ids.alpha!, f.alice, { body: "alice says" });
  await f.personComments(ids.alpha!, f.bob, { body: "bob's own" });
  const mentioned = await f.db.user.findUniqueOrThrow({ where: { id: f.bob } });
  await f.post(f.agents.writer, { operation: "comments", artifact: ids.alpha });
  await f.post(f.agents.writer, {
    operation: "comment",
    artifact: ids.alpha,
    body: `@${mentioned.username} see this`,
    idempotencyKey: f.key(),
  });
  const alpha = (await bobCards()).get(ids.alpha!)!;
  expect(alpha).toMatchObject({ hasUpdates: true, currentVersion: 2, mentionsYou: true });
  expect(alpha.commentCount).toBeGreaterThanOrEqual(3);
  expect(alpha.newComments).toBe(2);
  await positions.open({ workspaceId: f.workspaceId, artifactId: ids.alpha!, userId: f.bob });
  expect((await bobCards()).get(ids.alpha!)).toMatchObject({
    hasUpdates: false,
    newComments: 0,
    mentionsYou: false,
  });
  const never = (await bobCards()).get(ids.beta!)!;
  expect(never).toMatchObject({ hasUpdates: false, newComments: 0 });
});

test("marks come only for the artifacts the person may read", async () => {
  const marks = await gallery.marks({
    workspaceId: f.workspaceId,
    userId: f.bob,
    artifactIds: [ids.alpha!, ids.beta!, ids.gamma!],
  });
  expect(marks.map((mark) => mark.id).sort()).toEqual([ids.alpha!, ids.beta!].sort());
  expect(marks.find((mark) => mark.id === ids.beta)).toMatchObject({ link: true });
});

test("marks cost the same queries for one artifact or many", async () => {
  const counted: string[] = [];
  const countingDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL! }),
    log: [{ emit: "event", level: "query" }],
  });
  countingDb.$on("query", (event) => counted.push(event.query));
  const counting = new ArtifactGallery(countingDb, async () => true, f.artifacts.reads);
  const queriesFor = async (artifactIds: string[]) => {
    counted.length = 0;
    await counting.marks({ workspaceId: f.workspaceId, userId: f.bob, artifactIds });
    return counted.length;
  };
  try {
    const one = await queriesFor([ids.alpha!]);
    expect(await queriesFor([ids.alpha!, ids.beta!, ids.delta!])).toBe(one);
  } finally {
    await countingDb.$disconnect();
  }
});

test("a gallery page costs a fixed number of queries however many artifacts the Workspace holds", async () => {
  const counted: string[] = [];
  const countingDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString: Bun.env.DATABASE_URL! }),
    log: [{ emit: "event", level: "query" }],
  });
  countingDb.$on("query", (event) => counted.push(event.query));
  const counting = new ArtifactGallery(countingDb, async () => true, f.artifacts.reads);
  const queriesOf = async (extra: Partial<Parameters<ArtifactGallery["page"]>[0]>) => {
    counted.length = 0;
    await counting.page({
      workspaceId: f.workspaceId,
      userId: f.bob,
      sort: "opened",
      limit: 2,
      ...extra,
    });
    return counted.length;
  };
  try {
    const before = [await queriesOf({}), await queriesOf({ related: true, query: "a" })];
    for (let index = 0; index < 5; index++) await f.make(`Extra ${index}`);
    const after = [await queriesOf({}), await queriesOf({ related: true, query: "a" })];
    expect(after).toEqual(before);
    expect(before).toEqual([7, 7]);
  } finally {
    await countingDb.$disconnect();
  }
});

test("the link tier reads and lists like the workspace tier", async () => {
  const id = await f.make("Link-tier note", undefined, { target: `#${f.privateChannel}` });
  await f.db.$executeRaw`UPDATE "artifacts" SET "access" = 'link' WHERE "id" = ${id}::uuid`;
  try {
    expect(await titles(f.bob)).toContain("Link-tier note");
    expect(await titles(f.alice, { scope: { kind: "workspace" } })).toEqual([
      "Delta report",
      "Link-tier note",
    ]);
    expect(artifactTier({ homeKey: `conversation:${crypto.randomUUID()}`, access: "link" })).toBe(
      "workspace",
    );
  } finally {
    await f.db.artifact.delete({ where: { id } });
  }
});

test("the roster counts the others who have seen the latest version, apart from those still behind", async () => {
  const id = await f.make("Latest plan");
  const place = (userId: string) => ({ workspaceId: f.workspaceId, artifactId: id, userId });
  await positions.open(place(f.alice));
  await positions.open(place(f.bob));
  expect(await positions.roster(place(f.alice))).toMatchObject({ seenLatest: 1, behind: 0 });
  await f.db.artifact.update({ where: { id }, data: { currentVersion: 2 } });
  expect(await positions.roster(place(f.alice))).toMatchObject({ seenLatest: 0, behind: 1 });
  await positions.open(place(f.bob));
  expect(await positions.roster(place(f.alice))).toMatchObject({ seenLatest: 1, behind: 0 });
  expect(await positions.roster(place(f.bob))).toMatchObject({ seenLatest: 0, behind: 1 });
});
