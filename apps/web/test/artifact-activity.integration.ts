import { afterAll, beforeAll, expect, test } from "bun:test";
import { ArtifactPersonFollows } from "#src/server/artifacts/artifact-person-follows.server";
import { ArtifactViewerPositions } from "#src/server/artifacts/artifact-viewer-positions.server";
import { ArtifactPersonComments } from "#src/server/artifacts/artifact-person-comments.server";
import { ArtifactCommentDrafts } from "#src/server/artifacts/artifact-comment-drafts.server";
import type { ArtifactSignals } from "#src/server/artifacts/artifact-signals.server";
import { ActivityInbox } from "#src/server/inbox/activity-inbox.server";
import { userConversationChannel } from "#src/features/conversations/conversation-realtime";
import { commentDraftInput } from "#src/features/artifacts/artifact-comment-inputs";
import { commentsFixture, type CommentsFixture } from "./helpers/artifact-comments-fixture";
import { isArtifact } from "./helpers/activity-inbox-fixture";
import { lines } from "./helpers/artifact-drafts-harness";

let f: CommentsFixture;
let follows: ArtifactPersonFollows;
let positions: ArtifactViewerPositions;
let comments: ArtifactPersonComments;
let drafts: ArtifactCommentDrafts;
let inbox: ActivityInbox;
let woken: string[] = [];
let pending: Promise<void>[] = [];
let signalsDown = false;

beforeAll(async () => {
  f = await commentsFixture("aa");
  follows = new ArtifactPersonFollows(f.db, f.artifacts.reads);
  positions = new ArtifactViewerPositions(f.db, f.artifacts.reads);
  const signals: ArtifactSignals = {
    publish: async (channel, event) => {
      if (signalsDown) throw new Error("realtime is down");
      if (event.type === "activity.changed.v1") woken.push(channel);
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
const follow = (artifactId: string, userId: string) =>
  follows.set({ ...place(artifactId, userId), following: true });
const opened = (artifactId: string, userId: string, at: Date) =>
  f.db.artifactViewerPosition.upsert({
    where: { artifactId_userId: { artifactId, userId } },
    create: { artifactId, userId, openedAt: at, seenVersion: 1 },
    update: { openedAt: at },
  });
const afterMake = async (artifactId: string) =>
  new Date(
    (
      await f.db.artifactVersion.findFirstOrThrow({
        where: { artifactId },
        orderBy: { number: "desc" },
      })
    ).createdAt.getTime() + 1,
  );
const say = (artifactId: string, userId: string, body: string, rootId?: string) =>
  comments.post({
    ...place(artifactId, userId),
    comment: commentDraftInput.parse({
      body,
      idempotencyKey: f.key(),
      ...(rootId ? { replyTo: rootId } : {}),
    }),
  });
async function sendReview(artifactId: string, userId: string, bodies: string[]) {
  for (const body of bodies)
    await drafts.create({
      ...place(artifactId, userId),
      draft: { version: 1, body, path: "plan.md", anchor: lines },
    } as Parameters<ArtifactCommentDrafts["create"]>[0]);
  const held = await drafts.list(place(artifactId, userId));
  const sent = await drafts.submit({
    ...place(artifactId, userId),
    draftIds: held.drafts.map((draft) => draft.id),
    clientKey: f.key(),
  });
  if (sent.status !== "sent") throw new Error("review not sent");
  return sent;
}
const itemsOf = async (userId: string, filter: "all" | "unread" | "mentions" = "all") =>
  (await inbox.list(f.workspaceId, userId, { filter })).items.filter(isArtifact);
const itemFor = async (artifactId: string, userId: string) =>
  (await itemsOf(userId)).find((item) => item.artifact.id === artifactId);
const usernameOf = async (userId: string) =>
  (await f.db.user.findUniqueOrThrow({ where: { id: userId } })).username;

test("a follower sees one item per artifact with the latest event and the unread counts", async () => {
  const artifact = await f.make("Followed plan");
  await follow(artifact, f.bob);
  await opened(artifact, f.bob, await afterMake(artifact));
  expect(await itemFor(artifact, f.bob)).toBeUndefined();

  await f.personComments(artifact, f.alice, { body: "first thought" });
  await f.personComments(artifact, f.alice, { body: "second thought" });
  const item = (await itemFor(artifact, f.bob))!;
  expect(item).toMatchObject({
    key: `artifact:${artifact}`,
    unreadCount: 2,
    unreadMention: false,
    event: { kind: "comment", mentioned: false, preview: "second thought" },
  });
  expect(item.event.actor).toMatchObject({ kind: "user", name: "Alice" });
  expect(item.target.commentId).toBeString();
  expect(await itemsOf(f.alice)).toEqual([]);
});

test("a follower's item counts new versions; a version later than every comment is the latest event", async () => {
  const artifact = await f.make("Versioned plan");
  await follow(artifact, f.bob);
  await opened(artifact, f.bob, await afterMake(artifact));
  expect((await f.pushText(artifact, f.agents.writer, "revised\n")).status).toBe(200);
  const item = (await itemFor(artifact, f.bob))!;
  expect(item).toMatchObject({
    unreadCount: 1,
    event: { kind: "version", version: 2, mentioned: false },
    target: { version: null },
  });
  expect(item.event.actor).toMatchObject({ kind: "agent" });
  await f.personComments(artifact, f.alice, { body: "on the old one", version: 1 });
  expect(await itemFor(artifact, f.bob)).toMatchObject({
    unreadCount: 2,
    event: { kind: "comment" },
    target: { version: 1 },
  });
  const stranger = await f.make("Unfollowed versions");
  await opened(stranger, f.bob, await afterMake(stranger));
  await f.pushText(stranger, f.agents.writer, "again\n");
  expect(await itemFor(stranger, f.bob)).toBeUndefined();
});

test("an edited comment is the latest event; a deleted one is not counted", async () => {
  const artifact = await f.make("Edited plan");
  await follow(artifact, f.bob);
  await opened(artifact, f.bob, await afterMake(artifact));
  const said = await say(artifact, f.alice, "draft wording");
  await opened(artifact, f.bob, new Date());
  expect(await itemFor(artifact, f.bob)).toMatchObject({ unreadCount: 0 });
  await comments.edit({ ...place(artifact, f.alice), commentId: said.id, body: "final wording" });
  expect(await itemFor(artifact, f.bob)).toMatchObject({
    unreadCount: 1,
    event: { kind: "comment_edited", preview: "final wording" },
    target: { commentId: said.id },
  });
  await comments.remove({ ...place(artifact, f.alice), commentId: said.id });
  expect(await itemFor(artifact, f.bob)).toBeUndefined();
});

test("a review is one event with its comment count; a mention in it is the mention variant", async () => {
  const artifact = await f.make("Reviewed plan");
  await follow(artifact, f.bob);
  await opened(artifact, f.bob, await afterMake(artifact));
  const bobName = await usernameOf(f.bob);
  const sent = await sendReview(artifact, f.alice, ["one", `two @${bobName}`, "three"]);
  const item = (await itemFor(artifact, f.bob))!;
  expect(item).toMatchObject({
    unreadCount: 3,
    unreadMention: true,
    event: { kind: "review", mentioned: true, reviewComments: 3 },
  });
  expect(item.target.reviewId).toBe(sent.reviewId);
  expect((await itemsOf(f.bob, "mentions")).map((entry) => entry.artifact.id)).toContain(artifact);
});

test("a mentioned person follows from the mention on: the comment before it does not count, the one after does", async () => {
  const artifact = await f.make("Mention plan");
  const bobName = await usernameOf(f.bob);
  await f.personComments(artifact, f.alice, { body: "not about you" });
  await say(artifact, f.alice, `over to you, @${bobName}`);
  await f.personComments(artifact, f.alice, { body: `in code \`@${bobName}\` only` });
  const item = (await itemFor(artifact, f.bob))!;
  expect(item).toMatchObject({
    unreadCount: 2,
    unreadMention: true,
    event: { kind: "comment" },
  });
  expect((await itemsOf(f.bob, "unread")).map((entry) => entry.artifact.id)).toContain(artifact);
  const longer = await f.make("Not a handle");
  await say(longer, f.alice, `@${bobName}x and mail@${bobName}`);
  expect(await itemFor(longer, f.bob)).toBeUndefined();
});

test("someone who cannot read the artifact sees nothing, even following or mentioned, or after losing access", async () => {
  const bobName = await usernameOf(f.bob);
  const closed = await f.make("Closed plan", undefined, { target: `#${f.privateChannel}` });
  await f.db.artifactFollow.create({
    data: { artifactId: closed, userId: f.bob, following: true },
  });
  const told = await f.personComments(closed, f.alice, { body: `@${bobName} look` });
  await f.db.artifactCommentMention.create({
    data: { commentId: told.id, userId: f.bob, artifactId: closed, mentionedAt: told.createdAt },
  });
  expect(await itemFor(closed, f.bob)).toBeUndefined();

  const roomId = (
    await f.db.conversation.create({
      data: {
        workspaceId: f.workspaceId,
        channelName: `room-${crypto.randomUUID().slice(0, 8)}`,
        visibility: "private",
      },
    })
  ).id;
  const seats = await Promise.all(
    [f.alice, f.bob].map((userId) =>
      f.db.conversationMember.create({
        data: { conversationId: roomId, workspaceId: f.workspaceId, userId },
      }),
    ),
  );
  await f.db.conversationMember.create({
    data: { conversationId: roomId, workspaceId: f.workspaceId, agentId: f.agents.writer },
  });
  const room = await f.db.conversation.findUniqueOrThrow({ where: { id: roomId } });
  const shared = await f.make("Room plan", undefined, { target: `#${room.channelName}` });
  await follow(shared, f.bob);
  await opened(shared, f.bob, await afterMake(shared));
  await f.personComments(shared, f.alice, { body: "while you are in" });
  expect(await itemFor(shared, f.bob)).toBeDefined();
  await f.db.conversationMember.update({
    where: { id: seats[1]!.id },
    data: { leftAt: new Date() },
  });
  expect(await itemFor(shared, f.bob)).toBeUndefined();
  expect((await inbox.navAttention(f.workspaceId, f.bob)).unreadKeys ?? []).not.toContain(
    `artifact:${shared}`,
  );
});

test("opening the artifact reads the item without dropping it; the nav dot agrees with the list", async () => {
  const artifact = await f.make("Cleared plan");
  await follow(artifact, f.bob);
  await opened(artifact, f.bob, await afterMake(artifact));
  await f.personComments(artifact, f.alice, { body: "news" });
  const before = await inbox.navAttention(f.workspaceId, f.bob);
  expect(before.unreadKeys).toContain(`artifact:${artifact}`);
  const page = await inbox.list(f.workspaceId, f.bob, { filter: "all" });
  expect(page.unreadItemCount).toBe(before.unreadCount ?? 0);
  expect(page.items.map((item) => item.key)).toContain(`artifact:${artifact}`);

  await positions.open(place(artifact, f.bob));
  const after = await inbox.navAttention(f.workspaceId, f.bob);
  expect(after.unreadKeys ?? []).not.toContain(`artifact:${artifact}`);
  expect(await itemFor(artifact, f.bob)).toMatchObject({ unreadCount: 0 });
});

test("a person who comments, replies or sends a review follows, and a comment follows again after an unfollow", async () => {
  const artifact = await f.make("Auto follow plan");
  const row = () =>
    f.db.artifactFollow.findUnique({
      where: { artifactId_userId: { artifactId: artifact, userId: f.bob } },
    });
  expect(await row()).toBeNull();
  const root = await say(artifact, f.bob, "my comment");
  expect(await row()).toMatchObject({ following: true, unfollowedAt: null });
  await follows.set({ ...place(artifact, f.bob), following: false });
  expect(await row()).toMatchObject({ following: false });
  await say(artifact, f.alice, "reply", root.id);
  expect(await row()).toMatchObject({ following: false });
  await say(artifact, f.bob, "again", root.id);
  expect(await row()).toMatchObject({ following: true, unfollowedAt: null });

  await follows.set({ ...place(artifact, f.alice), following: false });
  await sendReview(artifact, f.alice, ["reviewed"]);
  expect(
    await f.db.artifactFollow.findUnique({
      where: { artifactId_userId: { artifactId: artifact, userId: f.alice } },
    }),
  ).toMatchObject({ following: true });
});

test("a write wakes the Activity of mentioned readers and person followers, never the writer", async () => {
  const artifact = await f.make("Wake plan");
  await follow(artifact, f.bob);
  const bobName = await usernameOf(f.bob);
  woken = [];
  await say(artifact, f.alice, `hello @${bobName}`);
  await Promise.all(pending);
  expect(woken).toEqual([userConversationChannel(f.bob)]);

  signalsDown = true;
  try {
    expect((await say(artifact, f.alice, "still works")).id).toBeString();
  } finally {
    signalsDown = false;
  }
});

test("an open page that keeps seeing advances the read point for what arrives", async () => {
  const artifact = await f.make("Watched plan");
  await follow(artifact, f.bob);
  await positions.open(place(artifact, f.bob));
  await f.personComments(artifact, f.alice, { body: "while you watch" });
  expect((await inbox.navAttention(f.workspaceId, f.bob)).unreadKeys).toContain(
    `artifact:${artifact}`,
  );
  await positions.seen(place(artifact, f.bob));
  expect((await inbox.navAttention(f.workspaceId, f.bob)).unreadKeys ?? []).not.toContain(
    `artifact:${artifact}`,
  );
  expect(await itemFor(artifact, f.bob)).toMatchObject({ unreadCount: 0 });
});

test("seen writes nothing for someone who cannot read the artifact, and says whether it changed anything", async () => {
  const closed = await f.make("Closed seen", undefined, { target: `#${f.privateChannel}` });
  await expect(positions.seen(place(closed, f.bob))).rejects.toThrow();
  expect(await f.db.artifactViewerPosition.count({ where: { artifactId: closed } })).toBe(0);

  const artifact = await f.make("Seen changes");
  await follow(artifact, f.bob);
  await positions.open(place(artifact, f.bob));
  await f.personComments(artifact, f.alice, { body: "fresh" });
  expect(await positions.seen(place(artifact, f.bob))).toBe(true);
  expect(await positions.seen(place(artifact, f.bob))).toBe(false);
});
