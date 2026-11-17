import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { commentDraftInput } from "#src/features/artifacts/artifact-comment-inputs";
import { writeMentions } from "#src/server/artifacts/artifact-comment-mention-rows.server";
import { postReview } from "#src/server/artifacts/artifact-comments.server";
import { ArtifactCommentDrafts } from "#src/server/artifacts/artifact-comment-drafts.server";
import { mentionHandles } from "#src/server/artifacts/artifact-notice-mentions.server";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import { ArtifactPersonFollows } from "#src/server/artifacts/artifact-person-follows.server";
import type { ArtifactSignals } from "#src/server/artifacts/artifact-signals.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { isArtifact } from "./helpers/activity-inbox-fixture";
import { lines } from "./helpers/artifact-drafts-harness";

let f: CommentsFixture;
let follows: ArtifactPersonFollows;
let comments: ArtifactPersonComments;
let drafts: ArtifactCommentDrafts;
let inbox: ActivityInbox;
let woken: string[] = [];
let pending: Promise<void>[] = [];
let signalsDown = false;
let gate: Promise<void> | undefined;

beforeAll(async () => {
  f = await commentsFixture("am");
  follows = new ArtifactPersonFollows(f.db, f.artifacts.reads);
  const signals: ArtifactSignals = {
    publish: async (channel, event) => {
      if (event.type !== "activity.changed.v1") return;
      await gate;
      if (signalsDown) throw new Error("realtime is down");
      woken.push(channel);
    },
    background: (work) => {
      pending.push(work());
    },
  };
  comments = new ArtifactPersonComments(f.db, f.blobs, async () => true, f.notices, signals);
  drafts = new ArtifactCommentDrafts(f.db, f.blobs, async () => true, f.notices, signals);
  inbox = new ActivityInbox(f.db, {});
});
afterAll(() => f.cleanup());

const place = (artifactId: string, userId: string) => ({
  workspaceId: f.workspaceId,
  artifactId,
  userId,
});
const say = (artifactId: string, userId: string, body: string, key = f.key(), rootId?: string) =>
  comments.post({
    ...place(artifactId, userId),
    comment: commentDraftInput.parse({
      body,
      idempotencyKey: key,
      ...(rootId ? { replyTo: rootId } : {}),
    }),
  });
const wakesSettled = async () => {
  await Promise.all(pending);
  pending = [];
};
const bobName = () =>
  f.db.user.findUniqueOrThrow({ where: { id: f.bob } }).then((user) => user.username);
const mentionRows = (artifactId: string) =>
  f.db.artifactCommentMention.findMany({ where: { artifactId, userId: f.bob } });
const followRow = (artifactId: string) =>
  f.db.artifactFollow.findUnique({
    where: { artifactId_userId: { artifactId, userId: f.bob } },
  });
const items = async (userId: string) =>
  (await inbox.list(f.workspaceId, userId, { filter: "all" })).items.filter(isArtifact);
const dotKeys = async (userId: string) =>
  (await inbox.navAttention(f.workspaceId, userId)).unreadKeys ?? [];
const readThrough = (artifactId: string) =>
  f.db.artifactViewerPosition.upsert({
    where: { artifactId_userId: { artifactId, userId: f.bob } },
    create: { artifactId, userId: f.bob, openedAt: new Date(), seenVersion: 1 },
    update: { openedAt: new Date() },
  });
const followFresh = async (title: string) => {
  const artifact = await f.make(title);
  await follows.set({ ...place(artifact, f.bob), following: true });
  await readThrough(artifact);
  return artifact;
};

const vectors = (name: string): [string, boolean][] => [
  [`hi @${name}`, true],
  [`@${name}, please look.`, true],
  [`(@${name})`, true],
  [`[x](https://example.com/@${name})`, false],
  [`see https://example.com/@${name}`, false],
  [`mail@${name}`, false],
  [`\\@${name}`, false],
  [`&#64;${name}`, false],
  [`inline \`@${name}\` code`, false],
  [`\`\`\`\n@${name}\n\`\`\``, false],
  [`text\n\n    @${name}`, false],
  [`<span>@${name}</span>`, true],
  [`@${name}x`, false],
];

test("the mention rows equal the SDK resolver on its vectors, for a post, an edit, a reply and a review", async () => {
  const name = await bobName();
  const artifact = await f.make("Vector plan");
  const root = await say(artifact, f.alice, "root");
  for (const [body, expected] of vectors(name)) {
    expect([body, mentionHandles(body).includes(name)]).toEqual([body, expected]);
    const posted = await say(artifact, f.alice, body);
    const reply = await say(artifact, f.alice, body, f.key(), root.id);
    const rows = (await mentionRows(artifact)).map((row) => row.commentId);
    expect([body, rows.includes(posted.id), rows.includes(reply.id)]).toEqual([
      body,
      expected,
      expected,
    ]);
    const swapped = await say(artifact, f.alice, "plain");
    await comments.edit({ ...place(artifact, f.alice), commentId: swapped.id, body });
    expect((await mentionRows(artifact)).some((row) => row.commentId === swapped.id)).toBe(
      expected,
    );
    await comments.edit({ ...place(artifact, f.alice), commentId: swapped.id, body: "plain" });
    expect((await mentionRows(artifact)).some((row) => row.commentId === swapped.id)).toBe(false);
  }
  const reviewArtifact = await f.make("Vector review");
  for (const body of ["one", `two @${name}`])
    await drafts.create({
      ...place(reviewArtifact, f.alice),
      draft: { version: 1, body, path: "plan.md", anchor: lines },
    } as Parameters<ArtifactCommentDrafts["create"]>[0]);
  const held = await drafts.list(place(reviewArtifact, f.alice));
  const sent = await drafts.submit({
    ...place(reviewArtifact, f.alice),
    draftIds: held.drafts.map((draft) => draft.id),
    clientKey: f.key(),
  });
  expect(sent.status).toBe("sent");
  expect(await mentionRows(reviewArtifact)).toHaveLength(1);
  expect(await followRow(reviewArtifact)).toMatchObject({ following: true });
});

test("a mentioned reader follows; a mentioned person who cannot read does not", async () => {
  const name = await bobName();
  const artifact = await f.make("Follow by mention");
  expect(await followRow(artifact)).toBeNull();
  await say(artifact, f.alice, `@${name}`);
  expect(await followRow(artifact)).toMatchObject({ following: true });

  const closed = await f.make("Closed mention", undefined, { target: `#${f.privateChannel}` });
  const told = await f.personComments(closed, f.alice, { body: `@${name}` });
  const row = await f.db.artifact.findUniqueOrThrow({ where: { id: closed } });
  await writeMentions(f.db, { workspaceId: f.workspaceId, artifact: row }, [
    {
      target: { commentId: told.id },
      people: [{ id: f.bob, username: name }],
      at: told.createdAt,
      authorUserId: f.alice,
    },
  ]);
  expect(await followRow(closed)).toBeNull();
});

test("a person's own published versions never make an item for them", async () => {
  const artifact = await f.make("Own versions");
  await follows.set({ ...place(artifact, f.alice), following: true });
  await follows.set({ ...place(artifact, f.bob), following: true });
  expect((await f.pushText(artifact, f.agents.writer, "v2\n")).status).toBe(200);
  await f.db.artifactVersion.updateMany({
    where: { artifactId: artifact, number: 2 },
    data: { publisherAgentId: null, publisherUserId: f.alice },
  });
  expect((await items(f.alice)).map((item) => item.artifact.id)).not.toContain(artifact);
  expect((await items(f.bob)).map((item) => item.artifact.id)).toContain(artifact);
  expect(await dotKeys(f.alice)).not.toContain(`artifact:${artifact}`);
});

const listed = async (userId: string) => (await items(userId)).map((item) => item.artifact.id);
const readPoint = (artifactId: string) =>
  f.db.artifactFollow.findUniqueOrThrow({
    where: { artifactId_userId: { artifactId, userId: f.bob } },
    select: { readAt: true, doneAt: true },
  });

test("mark read keeps the item listed without a dot; Done removes it; read all and Done all follow", async () => {
  const first = await followFresh("Read one");
  const second = await followFresh("Read two");
  const third = await followFresh("Read three");
  for (const id of [first, second, third]) await say(id, f.alice, "news");
  expect(await dotKeys(f.bob)).toEqual(
    expect.arrayContaining([first, second, third].map((id) => `artifact:${id}`)),
  );
  const at = Date.now();
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: first,
    throughAt: at,
  });
  expect(await dotKeys(f.bob)).not.toContain(`artifact:${first}`);
  expect(await listed(f.bob)).toContain(first);
  expect((await items(f.bob)).find((item) => item.artifact.id === first)).toMatchObject({
    unreadCount: 0,
  });
  await inbox.markDone(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: second,
    throughAt: at,
  });
  expect(await dotKeys(f.bob)).not.toContain(`artifact:${second}`);
  expect(await listed(f.bob)).not.toContain(second);
  await inbox.markAllRead(f.workspaceId, f.bob, { before: new Date(at) });
  expect(await dotKeys(f.bob)).not.toContain(`artifact:${third}`);
  expect(await listed(f.bob)).toContain(third);
  await say(first, f.alice, "after the read");
  expect((await items(f.bob)).find((item) => item.artifact.id === first)).toMatchObject({
    unreadCount: 1,
  });
  const done = await inbox.markAllDone(f.workspaceId, f.bob, { before: new Date() });
  expect(await listed(f.bob)).not.toEqual(expect.arrayContaining([first]));
  await inbox.undoDone(f.workspaceId, f.bob, done.undo!);
  expect(await listed(f.bob)).toEqual(expect.arrayContaining([first, third]));
  expect((await items(f.bob)).find((item) => item.artifact.id === first)).toMatchObject({
    unreadCount: 1,
  });
});

test("Done and its undo restore the previous read and done points", async () => {
  const artifact = await followFresh("Undo points");
  await say(artifact, f.alice, "one");
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: artifact,
    throughAt: Date.now(),
  });
  const read = await readPoint(artifact);
  expect(read.readAt).not.toBeNull();
  await say(artifact, f.alice, "two");
  const done = await inbox.markAllDone(f.workspaceId, f.bob, { before: new Date() });
  expect((await readPoint(artifact)).doneAt).not.toBeNull();
  await inbox.undoDone(f.workspaceId, f.bob, done.undo!);
  expect(await readPoint(artifact)).toEqual({ readAt: read.readAt, doneAt: null });
});

test("Activity never writes viewer positions, and a person who cannot read the artifact cannot mark it", async () => {
  const artifact = await followFresh("No positions");
  await say(artifact, f.alice, "news");
  const before = await f.db.artifactViewerPosition.count({ where: { artifactId: artifact } });
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: artifact,
    throughAt: Date.now(),
  });
  await inbox.markAllRead(f.workspaceId, f.bob, { before: new Date() });
  await inbox.markAllDone(f.workspaceId, f.bob, { before: new Date() });
  expect(await f.db.artifactViewerPosition.count({ where: { artifactId: artifact } })).toBe(before);

  const closed = await f.make("Closed marks", undefined, { target: `#${f.privateChannel}` });
  await f.db.artifactFollow.create({
    data: { artifactId: closed, userId: f.bob, following: true },
  });
  await f.personComments(closed, f.alice, { body: "secret" });
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: closed,
    throughAt: Date.now(),
  });
  await inbox.markDone(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: closed,
    throughAt: Date.now(),
  });
  expect(await readPoint(closed)).toEqual({ readAt: null, doneAt: null });
  expect(await f.db.artifactViewerPosition.count({ where: { artifactId: closed } })).toBe(0);

  const stranger = await f.make("Never followed");
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: stranger,
    throughAt: Date.now(),
  });
  expect(await f.db.artifactFollow.count({ where: { artifactId: stranger, userId: f.bob } })).toBe(
    0,
  );
});

test("the comment that mentions someone counts for them: the window is inclusive", async () => {
  const artifact = await f.make("Inclusive window");
  const name = await bobName();
  await say(artifact, f.alice, `@${name} first`);
  expect(await items(f.bob)).toEqual([expect.objectContaining({ unreadCount: 1 })]);
});

test("a mention in a review body belongs to the review, so deleting its comment keeps it", async () => {
  const name = await bobName();
  const artifact = await f.make("Review mention");
  const { review, comments: written } = await postReview(
    f.db,
    f.blobs,
    { workspaceId: f.workspaceId, agentId: f.agents.writer },
    {
      artifact,
      body: `@${name} look`,
      comments: [{ body: "plain" }],
      idempotencyKey: f.key(),
    } as Parameters<typeof postReview>[3],
  );
  expect(await mentionRows(artifact)).toEqual([
    expect.objectContaining({ reviewId: review.id, commentId: null }),
  ]);
  await f.db.artifactComment.deleteMany({ where: { id: { in: written.map(({ id }) => id) } } });
  expect(await mentionRows(artifact)).toHaveLength(1);
});

test("the edit mention rows and the edit audience use the same capped, resolved set", async () => {
  const name = await bobName();
  const artifact = await f.make("Edit audience");
  const swapped = await say(artifact, f.alice, "plain");
  woken = [];
  await comments.edit({ ...place(artifact, f.alice), commentId: swapped.id, body: `@${name} now` });
  await wakesSettled();
  expect((await mentionRows(artifact)).map((row) => row.commentId)).toEqual([swapped.id]);
  expect(woken).toContain(userConversationChannel(f.bob));
});

test("a re-follow counts from the re-follow, and a replayed post does not follow again", async () => {
  const artifact = await followFresh("Refollow");
  await say(artifact, f.alice, "while following");
  await follows.set({ ...place(artifact, f.bob), following: false });
  await say(artifact, f.alice, "while away");
  await follows.set({ ...place(artifact, f.bob), following: true });
  const itemOf = async () => (await items(f.bob)).find((item) => item.artifact.id === artifact);
  expect(await itemOf()).toBeUndefined();
  await say(artifact, f.alice, "after");
  expect(await itemOf()).toMatchObject({ unreadCount: 1 });

  const replayKey = f.key();
  const other = await f.make("Replay");
  await say(other, f.bob, "mine", replayKey);
  await follows.set({ ...place(other, f.bob), following: false });
  const replayed = await say(other, f.bob, "mine", replayKey);
  expect(replayed.id).toBeString();
  expect(await followRow(other)).toMatchObject({ following: false });
});

test("the wake runs after the write returns, and a failing wake never fails the write", async () => {
  const artifact = await followFresh("Wake");
  woken = [];
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  const posted = await say(artifact, f.alice, "waiting on realtime");
  expect(posted.id).toBeString();
  expect(woken).toEqual([]);
  release();
  gate = undefined;
  await wakesSettled();
  expect(woken).toContain(userConversationChannel(f.bob));

  signalsDown = true;
  try {
    expect((await say(artifact, f.alice, "realtime is down")).id).toBeString();
    await wakesSettled();
  } finally {
    signalsDown = false;
  }
});

test("deleting a comment wakes the people its mentions told", async () => {
  const name = await bobName();
  const artifact = await f.make("Wake on delete");
  const told = await say(artifact, f.alice, `@${name}`);
  await wakesSettled();
  await follows.set({ ...place(artifact, f.bob), following: false });
  woken = [];
  await comments.remove({ ...place(artifact, f.alice), commentId: told.id });
  await wakesSettled();
  expect(woken).toContain(userConversationChannel(f.bob));
  expect(await mentionRows(artifact)).toEqual([]);
});

test("undo of Done-all leaves an item read that was marked read after the Done", async () => {
  const artifact = await followFresh("Undo after read");
  await say(artifact, f.alice, "one");
  const done = await inbox.markAllDone(f.workspaceId, f.bob, { before: new Date() });
  await say(artifact, f.alice, "two");
  await inbox.markArtifactRead(f.workspaceId, f.bob, {
    kind: "artifact",
    artifactId: artifact,
    throughAt: Date.now(),
  });
  await inbox.undoDone(f.workspaceId, f.bob, done.undo!);
  expect((await items(f.bob)).find((item) => item.artifact.id === artifact)).toMatchObject({
    unreadCount: 0,
  });
  expect((await readPoint(artifact)).doneAt).toBeNull();
});

test("read all and Done all take only the artifacts with an event at or before the bound", async () => {
  const early = await followFresh("Early only");
  const late = await followFresh("Late only");
  const said = await say(early, f.alice, "early");
  const before = (await f.db.artifactComment.findUniqueOrThrow({ where: { id: said.id } }))
    .createdAt;
  const lateSaid = await say(late, f.alice, "late");
  const lateAt = (await f.db.artifactComment.findUniqueOrThrow({ where: { id: lateSaid.id } }))
    .createdAt;
  expect(lateAt.getTime()).toBeGreaterThan(before.getTime());
  const done = await inbox.markAllDone(f.workspaceId, f.bob, { before });
  const ids = done.undo!.artifacts.map((row) => row.artifactId);
  expect(ids).toContain(early);
  expect(ids).not.toContain(late);
  expect((await readPoint(late)).doneAt).toBeNull();
  await inbox.markAllRead(f.workspaceId, f.bob, { before });
  expect((await readPoint(late)).readAt).toBeNull();
});

test("a follow takes the database clock, not the application's", async () => {
  const artifact = await f.make("Skewed clock");
  setSystemTime(new Date("2001-01-01T00:00:00Z"));
  try {
    await follows.set({ ...place(artifact, f.bob), following: true });
  } finally {
    setSystemTime();
  }
  const row = await f.db.artifactFollow.findUniqueOrThrow({
    where: { artifactId_userId: { artifactId: artifact, userId: f.bob } },
  });
  expect(row.followedAt.getUTCFullYear()).toBeGreaterThan(2020);
});
